import { chooseRecordingMime } from './media-format.js';
import { bounded } from './async.js';
import { createFileResource } from './file-resource.js';
import { MEMORY_VIDEO_LIMIT, ensureStorageBudget, estimateMp4Bytes } from './storage-budget.js';
const pendingCleanups = new Set();
// Decode only the saved video, never the webpage or desktop. Native H.264/AAC
// encoding runs after capture, at playback speed; OPFS keeps output off JS heap.
export async function convertToMp4(sourceUrl, record, {
  storage = globalThis.navigator?.storage, locks = globalThis.navigator?.locks, urls = URL, signal: parentSignal, onProgress = () => {}, token = crypto.randomUUID(), timeoutMs = 15000, cleanupTimeoutMs = 1000
} = {}) {
  parentSignal?.throwIfAborted();
  if (pendingCleanups.size) throw new Error('上一项转换仍在结束本机读写，请稍后重试；原视频保留。');
  const controller = new AbortController(), signal = controller.signal;
  const abort = () => controller.abort(parentSignal.reason);

  const step = (operation, message, ms = timeoutMs) => bounded(operation, { signal, timeoutMs: ms, message });
  const mimeType = chooseRecordingMime('mp4');
  const video = document.createElement('video');
  if (typeof video.captureStream !== 'function') throw new Error('当前浏览器不支持本机视频转换，请升级 Chrome / Edge；原视频仍保留');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  let recorder, stream, file, name, objectUrl, timer, stopTimer, abortListener;
  let writes = Promise.resolve(), pendingBytes = 0, outputBytes = 0, error, settled = false, cleanupPromise;
  const chunks = [];
  let progressTask;
  const progress = () => {
    if (progressTask || signal.aborted) return;
    progressTask = step(() => onProgress(outputBytes, 0, { phase: 'converting', seconds: video.currentTime || 0,
    duration: Number.isFinite(video.duration) ? video.duration : (record.duration || 0) / 1000,
    percent: Number.isFinite(video.duration) && video.duration > 0 ? Math.min(99, video.currentTime / video.duration * 100) : null,
    temporaryName: name }), '转换进度暂未响应，原视频保留。', 5000)
      .catch(cause => controller.abort(cause)).finally(() => { progressTask = null; });
  };
  const releaseMedia = () => {
    clearInterval(timer); clearTimeout(stopTimer);
    signal.removeEventListener('abort', abortListener);
    parentSignal?.removeEventListener('abort', abort);
    video.pause(); stream?.getTracks().forEach(track => track.stop());
    video.removeAttribute('src'); video.load(); video.remove();
  };
  const cleanup = () => cleanupPromise ||= (async () => {
    releaseMedia();
    if (objectUrl) { urls.revokeObjectURL(objectUrl); objectUrl = undefined; }
    chunks.length = 0; await file?.cleanup();
  })();
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  try {
    if (storage?.getDirectory) {
      await ensureStorageBudget(storage, estimateMp4Bytes(record), { signal, label: 'MP4 临时文件' });
      name = `convert-${String(token).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 100) || crypto.randomUUID()}.mp4`;
      try {
        file = await createFileResource({ storage, locks, folder: 'yinglu-exports', name, signal,
          timeoutMs, cleanupTimeoutMs, pendingCleanups });
      } catch (cause) { if (!['NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(cause.name)) throw cause; }
    }
    if (!file && record.bytes > MEMORY_VIDEO_LIMIT) throw new Error('当前环境不能低内存转换这段大视频，请直接保存原视频；原视频保留。');
    progress();
    signal?.throwIfAborted();
    await step(() => new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('原视频无法解码，不能转换为 MP4；请先检查原片'));
      video.src = sourceUrl; video.load();
    }), '读取原视频超时，转换未开始');
    signal?.throwIfAborted();
    stream = video.captureStream();
    if (!stream.getVideoTracks().length) {
      await step(() => video.play(), '播放原视频超时');
      await step(() => new Promise(resolve => {
        if (stream.getVideoTracks().length) resolve();
        else stream.addEventListener('addtrack', () => { if (stream.getVideoTracks().length) resolve(); });
      }), '未能取得原视频轨道', 5000);
      video.pause();
      if (video.currentTime > 0) await step(() => new Promise(resolve => { video.onseeked = resolve; video.currentTime = 0; }), '原视频无法回到起点', 5000);
    }
    const pixels = (record.width || video.videoWidth) * (record.height || video.videoHeight);
    recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(Math.max(2000000, Math.min(16000000, pixels * (record.fps || 30) * .13))) });
    await new Promise((resolve, reject) => {
      const fail = cause => {
        error ||= cause;
        if (settled) return;
        settled = true; controller.abort(cause);
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* Release below remains necessary. */ }
        reject(cause);
      };
      abortListener = () => fail(signal.reason || new DOMException('已取消转换，原视频保留', 'AbortError'));
      signal?.addEventListener('abort', abortListener, { once: true });
      recorder.onerror = event => fail(event.error || new Error('MP4 编码失败；原视频仍保留'));
      video.onerror = () => fail(new Error('原视频解码中断，转换未完成；原视频仍保留'));
      recorder.ondataavailable = event => {
        if (!event.data.size || settled) return;
        pendingBytes += event.data.size;
        if (!file && outputBytes + pendingBytes > MEMORY_VIDEO_LIMIT) { fail(new Error('转换结果超过内存兼容预算，请使用支持文件暂存的环境；原视频保留')); return; }
        if (pendingBytes > 32 * 1024 * 1024) { fail(new Error('转换文件写入跟不上编码，已取消；原视频仍保留')); return; }
        writes = writes.then(async () => {
          if (error) return;
          if (file) await file.write(event.data); else chunks.push(event.data);
          outputBytes += event.data.size; progress();
        }).catch(fail).finally(() => { pendingBytes -= event.data.size; });
      };
      recorder.onstop = () => {
        if (settled) return;
        settled = true;
        if (!video.ended) reject(new Error('转换在视频结束前中断，未导出不完整的 MP4'));
        else resolve();
      };
      video.onended = () => {
        try { if (recorder.state !== 'inactive') recorder.stop(); } catch (cause) { fail(cause); }
        stopTimer = setTimeout(() => fail(new Error('MP4 编码器未响应停止；原视频仍保留')), 5000);
      };
      let lastTime = video.currentTime, lastAdvance = performance.now();
      timer = setInterval(() => {
        if (video.currentTime > lastTime + .01) { lastTime = video.currentTime; lastAdvance = performance.now(); }
        else if (performance.now() - lastAdvance > 60000) fail(new Error('MP4 转换长时间没有进度，请保持导出页打开后重试'));
        progress();
      }, 1000);
      recorder.start(1000);
      video.play().catch(fail);
      if (signal?.aborted) abortListener();
    });
    await step(() => writes, '保存转换结果超时；原视频仍保留');
    if (progressTask) await progressTask;
    if (error) throw error;
    if (!outputBytes) throw new Error('MP4 编码器没有输出有效数据；原视频仍保留');
    signal?.throwIfAborted();
    let blob;
    if (file) {
      await file.close(); blob = await file.getFile();
      if (blob.size !== outputBytes) throw new Error('MP4 临时文件大小不完整，原视频保留。');
    } else blob = new Blob(chunks, { type: recorder.mimeType });
    const header = new Uint8Array(await step(() => blob.slice(0, 12).arrayBuffer(), '验证 MP4 文件超时', 5000));
    if (String.fromCharCode(...header.slice(4, 8)) !== 'ftyp') throw new Error('编码输出不是有效 MP4 文件，已保留原视频');
    signal?.throwIfAborted();
    if (error) throw error;
    objectUrl = urls.createObjectURL(blob);
    releaseMedia();
    return { url: objectUrl, storage: file ? 'opfs' : 'blob', cleanup, mimeType: recorder.mimeType, bytes: blob.size, temporaryName: name };
  } catch (cause) {
    await cleanup().catch(() => {});
    throw cause;
  }
}
