import { getMusicFile, listMusic, musicFileBlob, musicConfig } from './music-store.js';

function mediaReady(audio, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); signal?.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const loaded = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? null : new Error('这首音乐无法读取时长，请换一个文件。'));
    const failed = () => finish(new Error('浏览器无法播放这首音乐，请换一个受支持的文件。'));
    const aborted = () => finish(signal.reason || new DOMException('已取消音乐准备', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('读取音乐超时，请重试。')), 10000);
    audio.addEventListener('loadedmetadata', loaded, { once: true }); audio.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) return aborted();
    audio.load();
  });
}
const releaseAudio = audio => { audio.pause(); audio.removeAttribute('src'); audio.load(); };
export async function prepareMusicFile(file, { signal } = {}) {
  const blob = musicFileBlob(file), audio = document.createElement('audio'), url = URL.createObjectURL(blob);
  audio.preload = 'metadata'; audio.src = url;
  try { await mediaReady(audio, signal); return { name: file.name, blob, duration: audio.duration }; }
  finally { releaseAudio(audio); URL.revokeObjectURL(url); }
}

// The media element streams one compressed local file. It does not decode an
// entire playlist into AudioBuffers, create another context, or poll playback.
export async function createRecordingMusic({ context, destination, config, signal, onChange = () => {} }) {
  config = musicConfig(config);
  if (!config) throw new Error('请先选择要录入的音乐。');
  const [blob, tracks] = await Promise.all([getMusicFile(config.id), listMusic()]);
  signal?.throwIfAborted();
  if (!blob) throw new Error('所选音乐已被移除，请重新选择后录制。');
  const audio = document.createElement('audio'), url = URL.createObjectURL(blob);
  let closed = false, desired = true, recordingPaused = false, node, gain, playRevision = 0;
  audio.preload = 'auto'; audio.loop = config.loop; audio.src = url;
  const snapshot = () => ({ id: config.id, name: tracks.find(track => track.id === config.id)?.name || '本地音乐',
    volume: config.volume, loop: config.loop, playing: !closed && !audio.paused && !recordingPaused, ended: audio.ended, error: null });
  const changed = () => { if (!closed) onChange(snapshot()); };
  const close = () => {
    if (closed) return; closed = true; playRevision++;
    signal?.removeEventListener('abort', close);
    for (const [event, handler] of events) audio.removeEventListener(event, handler);
    releaseAudio(audio); node?.disconnect(); gain?.disconnect(); URL.revokeObjectURL(url);
  };
  const failed = () => { if (!closed) onChange({ ...snapshot(), playing: false, error: '音乐播放中断，视频继续录制；可暂停或更换文件后重录。' }); };
  const events = [['play', changed], ['pause', changed], ['ended', changed], ['error', failed]];
  signal?.addEventListener('abort', close, { once: true });
  try {
    await mediaReady(audio, signal); signal?.throwIfAborted();
    node = context.createMediaElementSource(audio); gain = context.createGain(); gain.gain.value = config.volume;
    node.connect(gain); gain.connect(destination); gain.connect(context.destination);
    for (const [event, handler] of events) audio.addEventListener(event, handler);
    async function play() {
      if (closed || recordingPaused || !desired) return;
      const revision = ++playRevision;
      if (audio.ended) audio.currentTime = 0;
      let timer;
      try { await Promise.race([audio.play(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('音乐无法开始播放，请先检查文件或关闭音乐后录制。')), 3000); })]); }
      catch (error) {
        if (closed || recordingPaused || !desired || revision !== playRevision) return;
        desired = false; audio.pause(); throw error;
      }
      finally { clearTimeout(timer); }
      if (closed || recordingPaused || !desired) audio.pause();
    }
    return {
      snapshot, close, start: play,
      setRecordingPaused(value) {
        recordingPaused = value;
        if (value) { playRevision++; audio.pause(); }
        else play().catch(error => { if (!closed && !recordingPaused) onChange({ ...snapshot(), error: error.message }); });
      },
      async control(command, value) {
        if (closed) throw new Error('音乐播放已结束');
        if (command === 'play') { desired = true; await play(); }
        else if (command === 'pause') { desired = false; playRevision++; audio.pause(); }
        else if (command === 'restart') { audio.currentTime = 0; desired = true; await play(); }
        else if (command === 'volume') {
          if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('音乐音量无效');
          config.volume = value; gain.gain.setTargetAtTime(value, context.currentTime, .02);
        } else if (command === 'loop') {
          if (typeof value !== 'boolean') throw new Error('循环设置无效'); config.loop = value; audio.loop = value;
        } else throw new Error('不支持的音乐操作');
        changed(); return snapshot();
      }
    };
  } catch (error) { close(); throw error; }
}
