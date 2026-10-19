import { elapsed } from './geometry.js';
import { saveRecording, saveChunk, deleteRecording, patchRecording } from './db.js';
import { createVideoOutput } from './video.js';
import { chooseRecordingMime } from './media-format.js';
import { createRecordingMusic } from './music-player.js';

async function within(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

// A terminal patch never replaces bytes or duration: a transaction that was
// already in flight may have committed more media than this instance observed.
const persistTerminal = (run, id) => within((async () => {
  let saved = await patchRecording(id, run.terminalPatch);
  if (run.startFailure && saved) {
    // A failed start can still have an already accepted chunk transaction.
    // Classify its persisted result without replacing confirmed bytes/duration.
    const status = saved.bytes ? 'interrupted' : 'error';
    if (saved.status !== status) {
      run.terminalPatch = { ...run.terminalPatch, status };
      saved = await patchRecording(id, run.terminalPatch);
    }
  }
  return saved;
})(), Math.min(run.finalizeTimeoutMs, 2500), '保存中断状态确认超时');

export class Recorder {
  constructor(onState = () => {}) {
    this.onState = onState;
    this.state = { status: 'idle' };
    this.streams = [];
  }
  publish(patch = {}) {
    Object.assign(this.state, patch);
    this.state.sequence = (this.state.sequence || 0) + 1;
    this.onState({ ...this.state });
  }
  performanceSnapshot() {
    try { if (this.videoOutput?.getPerformance) this.videoPerformance = this.videoOutput.getPerformance(); } catch { /* Diagnostics must not interrupt capture. */ }
    return { version: 1, video: this.videoPerformance || { pipeline: this.record?.pipeline || null },
      audio: { ...this.audioPerformance }, encoding: { ...this.encoderPerformance }, storage: { ...this.storagePerformance } };
  }
  publishProgress(patch) {
    Object.assign(this.state, patch);
    const now = performance.now();
    if (now - this.lastProgressAt < 1000) return;
    this.lastProgressAt = now;
    this.record.performance = this.performanceSnapshot();
    this.publish({ ...patch, performance: this.record.performance });
  }
  async start(sourceOrAcquire, options = {}) {
    if (this.preparation || ['recording', 'paused', 'preparing', 'saving'].includes(this.state.status)) throw new Error('已有录制正在进行');
    const controller = new AbortController();
    const run = this.run = { acceptingChunks: true, finalizing: false, abandoned: false,
      stopTimeoutMs: options.stopTimeoutMs || 3000, finalizeTimeoutMs: options.finalizeTimeoutMs || 15000 };
    let rejectCancelled;
    const cancellation = new Promise((_, reject) => { rejectCancelled = reject; });
    const attempt = this.preparation = { controller, cancel: (reason, cancelled) => {
      if (controller.signal.aborted) return;
      controller.abort(reason); rejectCancelled(reason);
      this.cleanup();
      this.publish({ status: cancelled ? 'cancelled' : 'error', error: cancelled ? null : reason.message, released: true });
    } };
    const wait = (promise, dispose = () => {}) => Promise.race([Promise.resolve(promise).then(value => {
      if (controller.signal.aborted) { dispose(value); throw controller.signal.reason; }
      return value;
    }), cancellation]);
    const stopStream = stream => stream?.getTracks().forEach(track => track.stop());
    const timeoutMs = options.prepareTimeoutMs || 20000;
    const timeout = setTimeout(() => attempt.cancel(new Error('准备录制超时，请检查来源及麦克风权限后重试。'), false), timeoutMs);
    this.state = { status: 'preparing', bytes: 0, pausedMs: 0, pausedAt: 0, music: null, ...options.context };
    this.streams = [];
    this.record = null; this.videoPerformance = null;
    this.audioPerformance = { mode: 'none', monitored: false, sourceTracks: 0, microphoneTracks: 0 };
    this.encoderPerformance = {};
    this.storagePerformance = { chunksReceived: 0, chunkWritesCompleted: 0, chunkWritesFailed: 0,
      chunkWriteMsTotal: 0, chunkWriteMsMax: 0, peakPendingBytes: 0, peakPendingChunks: 0,
      chunkIntervalCount: 0, chunkIntervalMsTotal: 0, chunkIntervalMsMin: null, chunkIntervalMsMax: 0 };
    this.lastChunkAt = null; this.lastProgressAt = performance.now(); this.pendingChunks = 0;
    this.publish();
    this.writes = Promise.resolve();
    this.writeError = null;
    this.index = 0;
    this.pendingBytes = 0;
    this.finalDuration = 0;
    try {
      const source = await wait(typeof sourceOrAcquire === 'function' ? sourceOrAcquire(controller.signal) : sourceOrAcquire, stopStream);
      this.streams.push(source);
      // Source acquisition may settle the tab's capture UI and finalize its
      // crop coordinates. Publish the same viewport used by the video output,
      // rather than a pre-acquisition context that could restore stale bounds.
      Object.assign(this.state, options.context);
      const sourceTrack = source.getVideoTracks()[0];
      if (!sourceTrack || sourceTrack.readyState === 'ended') throw new Error('录制来源已经停止，请重新选择');
      this.sourceTrack = sourceTrack;
      this.sourceEnded = () => this.stop('录制来源已停止，已保存现有片段。');
      sourceTrack.addEventListener('ended', this.sourceEnded);
      this.videoOutput = await wait(createVideoOutput(source, { ...options, signal: controller.signal,
        onSourceResize: message => this.stop(message) }), output => output.cleanup());
      const output = this.videoOutput.stream;
      this.streams.push(output);
      const sources = [];
      if (options.audio !== false && source.getAudioTracks().length) {
        sources.push({ stream: source, monitor: !!options.monitor });
        this.audioPerformance.sourceTracks = source.getAudioTracks().length;
      }
      if (options.microphone) {
        const mic = await wait(navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }), stopStream);
        this.streams.push(mic);
        if (mic.getAudioTracks().length) sources.push({ stream: mic, monitor: false });
        this.audioPerformance.microphoneTracks = mic.getAudioTracks().length;
      }
      if (sources.length || options.music) {
        const tracks = sources.flatMap(s => s.stream.getAudioTracks());
        const needsMixing = !!options.music || sources.length > 1 || tracks.length > 1;
        this.audioPerformance.mode = needsMixing ? 'mixed' : 'direct';
        this.audioPerformance.monitored = sources.some(s => s.monitor) || !!options.music;
        if (!needsMixing) output.addTrack(tracks[0]);
        // A single captured track can go straight to MediaRecorder. Chrome
        // tab playback still needs monitoring, but not another mixing stream.
        if (needsMixing || this.audioPerformance.monitored) {
          this.audio = new AudioContext();
          const mixed = needsMixing ? this.audio.createMediaStreamDestination() : null;
          if (mixed) this.streams.push(mixed.stream);
          sources.forEach(s => {
            const node = this.audio.createMediaStreamSource(s.stream);
            if (mixed) node.connect(mixed);
            if (s.monitor) node.connect(this.audio.destination);
          });
          if (options.music) {
            this.music = await wait(createRecordingMusic({ context: this.audio, destination: mixed,
              config: options.music, signal: controller.signal, onChange: music => {
                if (this.run === run && !run.finalizing && !controller.signal.aborted) this.publish({ music });
              } }), music => music.close());
            this.state.music = this.music.snapshot();
            this.audioPerformance.music = { id: this.state.music.id, name: this.state.music.name, initialVolume: this.state.music.volume, loop: this.state.music.loop };
          }
          await wait(this.audio.resume());
          if (mixed) mixed.stream.getAudioTracks().forEach(t => output.addTrack(t));
        }
      }
      const mimeType = chooseRecordingMime(options.format || 'webm');
      const pixels = this.videoOutput.width * this.videoOutput.height;
      const bitrate = Math.round(Math.max(2000000, Math.min(16000000, pixels * (options.fps || 30) * .13)));
      this.mediaRecorder = new MediaRecorder(output, { mimeType, videoBitsPerSecond: bitrate });
      this.encoderPerformance = { mimeType: this.mediaRecorder.mimeType, requestedVideoBitsPerSecond: bitrate,
        reportedVideoBitsPerSecond: this.mediaRecorder.videoBitsPerSecond ?? null,
        reportedAudioBitsPerSecond: this.mediaRecorder.audioBitsPerSecond ?? null };
      this.record = { id: crypto.randomUUID(), createdAt: Date.now(), title: options.title || '屏幕演示',
        mimeType: this.mediaRecorder.mimeType, format: this.mediaRecorder.mimeType.split(';')[0].trim().toLowerCase() === 'video/mp4' ? 'mp4' : 'webm',
        width: this.videoOutput.width, height: this.videoOutput.height,
        pipeline: this.videoOutput.mode,
        fps: options.fps || 30, bytes: 0, duration: 0, status: 'recording' };
      if (this.state.music) this.record.music = { ...this.audioPerformance.music };
      this.record.performance = this.performanceSnapshot();
      this.publish({ id: this.record.id });
      const initialRecord = this.record;
      await wait(saveRecording(initialRecord), () => { deleteRecording(initialRecord.id).catch(() => {}); });
      this.mediaRecorder.ondataavailable = e => {
        if (this.run !== run || !run.acceptingChunks || !e.data.size || this.writeError) return;
        const index = this.index++;
        const record = this.record;
        const metrics = this.storagePerformance;
        const arrived = performance.now();
        const coveredDuration = this.state.status === 'saving' ? this.finalDuration : elapsed(this.state);
        if (this.lastChunkAt !== null) {
          const gap = arrived - this.lastChunkAt;
          metrics.chunkIntervalCount++; metrics.chunkIntervalMsTotal += gap;
          metrics.chunkIntervalMsMin = metrics.chunkIntervalMsMin === null ? gap : Math.min(metrics.chunkIntervalMsMin, gap);
          metrics.chunkIntervalMsMax = Math.max(metrics.chunkIntervalMsMax, gap);
        }
        this.lastChunkAt = arrived; metrics.chunksReceived++;
        this.pendingBytes += e.data.size;
        this.pendingChunks++;
        metrics.peakPendingBytes = Math.max(metrics.peakPendingBytes, this.pendingBytes);
        metrics.peakPendingChunks = Math.max(metrics.peakPendingChunks, this.pendingChunks);
        this.writes = this.writes.then(async () => {
          if (this.run !== run || run.abandoned || this.writeError) return;
          const updated = { ...record, bytes: record.bytes + e.data.size,
            duration: Math.max(record.duration, coveredDuration), performance: this.performanceSnapshot() };
          const writeStarted = performance.now();
          try { await saveChunk(record.id, index, e.data, updated); metrics.chunkWritesCompleted++; }
          catch (error) { metrics.chunkWritesFailed++; throw error; }
          finally {
            const writeMs = performance.now() - writeStarted;
            metrics.chunkWriteMsTotal += writeMs; metrics.chunkWriteMsMax = Math.max(metrics.chunkWriteMsMax, writeMs);
            // A late transaction can restore its old recording status. Repair
            // only that record, even if another recording has since started.
            if (run.terminalPatch) await persistTerminal(run, record.id).catch(() => {});
          }
          if (this.run !== run || run.abandoned) return;
          Object.assign(record, updated);
          if (!run.startFailure) this.publishProgress({ bytes: record.bytes, pendingBytes: this.pendingBytes - e.data.size });
        }).catch(error => {
          if (this.run !== run || run.abandoned || run.startFailure) return;
          this.writeError = error;
          const message = `保存失败：${error.message}。已写入的片段仍可尝试恢复。`;
          this.publish({ error: message });
          this.stop(message);
        }).finally(() => { if (this.run === run) { this.pendingBytes -= e.data.size; this.pendingChunks--; } });
        if (this.pendingBytes > 64 * 1024 * 1024) this.stop('磁盘写入跟不上录制，已停止采集并保存现有片段。');
      };
      this.mediaRecorder.onerror = event => { if (this.run === run && !run.finalizing) this.stop(event.error?.message || '视频编码中断'); };
      this.mediaRecorder.onstop = () => this.finalize(run);
      if (this.music) await wait(this.music.start());
      this.mediaRecorder.start(1000);
      this.lastProgressAt = performance.now();
      this.publish({ status: 'recording', startedAt: Date.now(), id: this.record.id,
        width: this.record.width, height: this.record.height, pipeline: this.record.pipeline, error: null, performance: this.record.performance });
    } catch (error) {
      run.acceptingChunks = false; run.finalizing = true;
      this.cleanup();
      this.mediaRecorder = null;
      if (!controller.signal.aborted) {
        const record = this.record;
        let recoveryPending = false;
        if (record) {
          run.startFailure = true;
          run.terminalPatch = { status: 'error', interruption: `录制启动失败：${error.message}`,
            attemptedDuration: 0, performance: this.performanceSnapshot() };
          try {
            const saved = await within(this.writes.then(() => persistTerminal(run, record.id)),
              Math.min(run.finalizeTimeoutMs, 2500), '启动失败状态保存超时');
            if (saved) Object.assign(record, { status: saved.status, bytes: saved.bytes, duration: saved.duration });
            else recoveryPending = true;
          } catch { run.abandoned = true; recoveryPending = true; }
          record.status = record.bytes ? 'interrupted' : 'error';
        }
        if (this.run === run && !controller.signal.aborted) this.publish({
          status: record?.bytes ? 'interrupted' : 'error', error: error.message, detail: error.detail || null, released: true,
          ...(record ? { bytes: record.bytes, duration: record.duration, recoveryPending } : {})
        });
      }
      throw error;
    } finally { clearTimeout(timeout); if (this.preparation === attempt) this.preparation = null; }
  }
  pause() {
    if (this.state.status !== 'recording') return;
    this.mediaRecorder.pause();
    this.music?.setRecordingPaused(true);
    this.videoOutput.setPaused(true);
    this.mediaRecorder.requestData();
    this.lastChunkAt = null;
    this.publish({ status: 'paused', pausedAt: Date.now() });
  }
  resume() {
    if (this.state.status !== 'paused') return;
    this.mediaRecorder.resume();
    this.music?.setRecordingPaused(false);
    this.lastChunkAt = null;
    this.publish({ status: 'recording', pausedMs: this.state.pausedMs + Date.now() - this.state.pausedAt, pausedAt: 0 });
    // A resumed render can detect a changed source and synchronously stop.
    // Publish first so that stop's saving state remains authoritative.
    this.videoOutput?.setPaused(false);
  }
  stop(error) {
    if (this.state.status === 'preparing') {
      this.preparation?.cancel(error ? new Error(error) : new DOMException('已取消准备录制', 'AbortError'), !error);
      return;
    }
    if (this.state.status === 'saving') {
      if (this.run && !this.run.finalizing) this.finalize(this.run, error || '编码器尚未完成停止，已强制释放采集。最后片段可能不完整。');
      else this.cleanup();
      return;
    }
    if (!['recording', 'paused'].includes(this.state.status)) return;
    this.finalDuration = elapsed(this.state);
    this.music?.setRecordingPaused(true);
    this.publish({ status: 'saving', error: error || null });
    this.videoOutput?.setPaused(true);
    const run = this.run;
    run.stopTimer = setTimeout(() => this.finalize(run, '编码器未响应停止，已释放采集并保存收到的片段。最后片段可能不完整。'), run.stopTimeoutMs);
    try { if (this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop(); }
    catch (cause) { this.finalize(run, `编码器停止失败：${cause.message}。已释放采集，最后片段可能不完整。`); }
  }
  async finalize(run = this.run, reason) {
    if (this.run !== run || run.finalizing) return;
    run.finalizing = true; run.acceptingChunks = false; clearTimeout(run.stopTimer);
    if (['recording', 'paused'].includes(this.state.status)) {
      this.finalDuration = elapsed(this.state);
      this.publish({ status: 'saving' });
    }
    if (reason) this.publish({ status: 'saving', error: reason });
    // MediaRecorder has delivered its final data before onstop. Capture can
    // now be released without waiting for disk writes to drain.
    this.cleanup();
    this.publish({ released: true });
    const record = this.record;
    try {
      await within(this.writes, run.finalizeTimeoutMs, '保存等待超时，已停止采集。已写入片段可在录制库恢复，末尾可能不完整。');
      if (this.run !== run) return;
      record.attemptedDuration = this.finalDuration;
      record.status = !record.bytes ? 'error' : this.state.error || this.writeError ? 'interrupted' : 'complete';
      const duration = record.status === 'complete' ? this.finalDuration : record.duration;
      if (!record.bytes) this.publish({ error: this.state.error || '录制未产生有效视频片段，请确认来源正常显示后重新录制。' });
      if (this.state.error) record.interruption = this.state.error;
      record.performance = this.performanceSnapshot();
      const finalSave = Promise.resolve(saveRecording({ ...record, duration })).finally(async () => {
        if (run.terminalPatch) await persistTerminal(run, record.id).catch(() => {});
      });
      await within(finalSave, run.finalizeTimeoutMs, '保存结果确认超时，请在录制库检查已写入片段。');
      if (this.run !== run) return;
      record.duration = duration;
      this.publish({ status: record.status, duration: record.duration, bytes: record.bytes, performance: record.performance });
    } catch (error) {
      run.abandoned = true;
      const message = `保存中断：${error.message}`;
      record.status = record.bytes ? 'interrupted' : 'error';
      record.performance = this.performanceSnapshot();
      run.terminalPatch = { status: record.bytes || this.pendingChunks ? 'interrupted' : 'error',
        interruption: message, attemptedDuration: this.finalDuration, performance: record.performance };
      let recoveryPending = false;
      try {
        const persisted = await persistTerminal(run, record.id);
        if (persisted) { record.bytes = persisted.bytes; record.duration = persisted.duration; }
        else recoveryPending = true;
      } catch { recoveryPending = true; }
      if (this.run !== run) return;
      this.publish({ status: record.bytes ? 'interrupted' : 'error', duration: record.duration,
        bytes: record.bytes, error: message, performance: record.performance, recoveryPending });
    } finally { if (this.run === run) this.mediaRecorder = null; }
  }
  cleanup() {
    try { if (this.videoOutput?.getPerformance) this.videoPerformance = this.videoOutput.getPerformance(); } catch { /* Cleanup takes priority over diagnostics. */ }
    this.sourceTrack?.removeEventListener?.('ended', this.sourceEnded);
    this.sourceTrack = null; this.sourceEnded = null;
    this.videoOutput?.cleanup();
    this.videoOutput = null;
    this.music?.close(); this.music = null;
    if (this.state.music) this.state.music = { ...this.state.music, playing: false };
    this.streams.forEach(s => s.getTracks().forEach(t => t.stop()));
    this.streams = [];
    this.audio?.close().catch(() => {});
    this.audio = null;
  }
  async controlMusic(command, value) {
    if (!['recording', 'paused'].includes(this.state.status) || !this.music) throw new Error('这次录制没有启用音乐，请在开始前选择并开启音乐。');
    await this.music.control(command, value);
    return this.state.music;
  }
}
