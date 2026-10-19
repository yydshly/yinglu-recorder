import { listMusic, getMusicFile, saveMusic, deleteMusic, getMusicPreferences, saveMusicPreferences, musicConfig } from './music-store.js';
import { prepareMusicFile } from './music-player.js';

const active = state => ['preparing', 'recording', 'paused', 'saving'].includes(state?.status);
const durationText = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export function createMusicPanel({ getRecording, canImport, send, onBusy, onError }) {
  const $ = id => document.getElementById(id), player = document.createElement('audio');
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('yinglu-music') : null;
  let tracks = [], prefs = { id: null, enabled: false, volume: .2, loop: true }, busy = false, loading = false, loaded = false, disposed = false;
  let refreshTask, dirty = true, preferencesKnown = false;
  let url, previewId, sourceRevision = 0, refreshRevision = 0, wasActive = false, deferredRefresh = false, editingVolume = false;
  player.preload = 'none';
  const status = text => { $('music-status').textContent = text; };
  const problem = error => { if (!disposed) onError(error); };
  const expanded = () => $('music-card').open && !document.hidden;
  function stopPreview() {
    ++sourceRevision; previewId = null;
    if (url) { player.pause(); player.removeAttribute('src'); player.load(); }
    if (url) URL.revokeObjectURL(url); url = null;
  }
  async function playPreview() {
    await primePreview();
    if (disposed || !expanded() || active(getRecording()) || !url) return;
    const revision = sourceRevision;
    try { await player.play(); }
    catch (error) {
      // Beginning a recording, switching songs or pausing intentionally aborts
      // a pending play(). Its late result belongs to the old preview only.
      if (disposed || revision !== sourceRevision || active(getRecording()) || error.name === 'AbortError' && player.paused) return;
      throw error;
    }
    if (!disposed && revision === sourceRevision && !active(getRecording()) && !player.paused)
      status('正在试听 · 只有开启“录制时加入”才会进入视频。');
  }
  async function primePreview() {
    if (disposed || !expanded() || active(getRecording()) || !prefs.id || previewId === prefs.id && url) return;
    stopPreview(); const revision = sourceRevision, id = prefs.id; previewId = id;
    const blob = await getMusicFile(id);
    if (disposed || !expanded() || revision !== sourceRevision || active(getRecording()) || prefs.id !== id) return;
    if (!blob) { previewId = null; throw new Error('这首音乐已被移除，请重新选择。'); }
    url = URL.createObjectURL(blob); player.src = url; player.volume = prefs.volume; player.loop = prefs.loop; render();
  }
  function render() {
    const state = getRecording(), recording = active(state), playing = !!state.music?.playing;
    if (recording !== wasActive) {
      wasActive = recording;
      if (recording) stopPreview();
      else {
        status('录制已结束，音乐已停止。');
        if (deferredRefresh) { deferredRefresh = false; refresh().catch(problem); }
      }
    }
    const ready = !disposed && loaded && !loading && !busy, chosen = !!prefs.id;
    $('music-import').disabled = !ready || recording || !canImport() || tracks.length >= 12;
    $('music-select').disabled = !ready || recording || !tracks.length;
    $('music-enabled').disabled = !ready || recording || !chosen;
    $('music-remove').disabled = !ready || recording || !chosen;
    $('music-play').disabled = !ready || (recording ? state.status !== 'recording' || !state.music : !chosen);
    $('music-restart').disabled = $('music-play').disabled;
    $('music-volume').disabled = $('music-loop').disabled = !ready || (recording ? !state.music || !['recording', 'paused'].includes(state.status) : !chosen);
    $('music-background').disabled = $('music-main').disabled = $('music-volume').disabled;
    $('music-play').textContent = recording ? state.status === 'paused' ? '随录制暂停' : playing ? '暂停音乐' : '播放音乐' : player.paused ? '试听' : '暂停试听';
    const volume = recording && state.music ? state.music.volume : prefs.volume;
    if (!editingVolume) { $('music-volume').value = String(Math.round(volume * 100)); $('music-volume-value').textContent = `${Math.round(volume * 100)}%`; }
    $('music-loop').checked = recording && state.music ? state.music.loop : prefs.loop;
    $('music-enabled').checked = prefs.enabled;
    $('music-summary-status').textContent = recording && state.music ? '录制音乐' : prefs.enabled && chosen ? '随录制加入' : '可选 · 本机收藏';
    if (recording && state.music) status(state.music.error || (state.status === 'saving' ? '音乐已停止，正在保存视频。' : `${state.music.name} · ${state.status === 'paused' ? '随录制暂停' : playing ? '正在录入视频' : '音乐已暂停，视频继续录制'}`));
  }
  function setBusy(value) { busy = value; onBusy(value); render(); }
  async function persist() { await saveMusicPreferences(prefs); channel?.postMessage('changed'); }
  function refresh() {
    if (disposed || !expanded()) { dirty = true; return Promise.resolve(); }
    if (refreshTask) { deferredRefresh = true; return refreshTask; }
    refreshTask = readLibrary().finally(() => {
      refreshTask = null;
      if (deferredRefresh && expanded() && !disposed && !busy && !active(getRecording())) {
        deferredRefresh = false; refresh().catch(problem);
      }
    });
    return refreshTask;
  }
  async function readLibrary() {
    const revision = ++refreshRevision;
    loading = true; render();
    try {
      const [next, settings] = await Promise.all([listMusic(), getMusicPreferences()]);
      if (disposed || revision !== refreshRevision) return;
      tracks = next; prefs = { ...prefs, ...settings }; preferencesKnown = true; dirty = false;
      if (!tracks.some(track => track.id === prefs.id)) prefs = { ...prefs, id: null, enabled: false };
      if (prefs.id !== previewId) stopPreview();
      player.volume = prefs.volume; player.loop = prefs.loop;
      $('music-select').replaceChildren();
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '选择本机收藏的音乐'; $('music-select').append(empty);
      for (const track of tracks) {
        const option = document.createElement('option'); option.value = track.id; option.textContent = `${track.name} · ${durationText(track.duration)}`; $('music-select').append(option);
      }
      $('music-select').value = prefs.id || ''; loading = false; loaded = true; $('music-retry').hidden = true;
      status(tracks.length ? `${tracks.length} / 12 首 · ${(tracks.reduce((total, track) => total + track.bytes, 0) / 1048576).toFixed(1)} / 128 MB · 本机收藏` : '导入本地音乐，选择后可试听或随录制加入。');
      render();
    } catch (error) {
      if (disposed || revision !== refreshRevision) return;
      loading = false; $('music-retry').hidden = false; status('音乐库暂不可用，可重试加载。'); render(); throw error;
    }
  }
  const safely = task => async () => { try { await task(); } catch (error) { problem(error); } };
  $('music-import').onclick = () => { if (!$('music-import').disabled) { $('music-files').value = ''; $('music-files').click(); } };
  $('music-files').onchange = safely(async () => {
    const files = Array.from($('music-files').files || []); $('music-files').value = '';
    if (!files.length || busy || active(getRecording()) || !canImport()) return;
    setBusy(true); let added = 0, firstError;
    const selected = files.slice(0, Math.max(0, 12 - tracks.length)), skipped = files.length - selected.length;
    try {
      for (const file of selected) {
        if (disposed || active(getRecording())) break;
        try {
          status(`正在准备：${file.name}`);
          const prepared = await prepareMusicFile(file);
          if (disposed || active(getRecording())) break;
          const saved = await saveMusic(prepared); added++;
          if (!prefs.id) prefs = { ...prefs, id: saved.id, enabled: true };
        } catch (error) { firstError ||= error; if (/最多|空间|超时|暂未响应/.test(error.message)) break; }
      }
      if (added) await persist();
      await refresh();
    } finally {
      if (!disposed) { setBusy(false); status(`已收藏 ${added} 首${skipped ? `；超过数量上限，跳过 ${skipped} 首` : ''}${firstError ? `；${firstError.message}` : '。选择音乐后可试听，开启后随录制从头播放。'}`); }
    }
  });
  $('music-select').onchange = safely(async () => {
    if (busy || active(getRecording())) return;
    stopPreview(); prefs.id = $('music-select').value || null; prefs.enabled = !!prefs.id;
    render(); await persist(); render();
  });
  $('music-enabled').onchange = safely(async () => { if (active(getRecording())) return; prefs.enabled = $('music-enabled').checked; await persist(); render(); });
  $('music-play').onclick = safely(async () => {
    if ($('music-play').disabled) return;
    const state = getRecording();
    if (active(state)) await send(state.music.playing ? 'pause' : 'play', undefined, state.sessionId);
    else if (player.paused) { setBusy(true); try { await playPreview(); } finally { setBusy(false); } }
    else { player.pause(); status('试听已暂停。'); }
    render();
  });
  $('music-restart').onclick = safely(async () => {
    if ($('music-restart').disabled) return;
    const state = getRecording();
    if (active(state)) await send('restart', undefined, state.sessionId);
    else { setBusy(true); try { await primePreview(); player.currentTime = 0; await playPreview(); } finally { setBusy(false); } } render();
  });
  async function volume(value) {
    const state = getRecording(), sessionId = state.sessionId;
    prefs.volume = value; player.volume = value;
    if (active(state) && state.music) await send('volume', value, sessionId);
    await persist(); render();
  }
  $('music-volume').oninput = () => {
    const value = Number($('music-volume').value);
    $('music-volume-value').textContent = `${value}%`;
    editingVolume = true;
    if (!active(getRecording())) player.volume = value / 100;
  };
  $('music-volume').onchange = safely(() => { editingVolume = false; return volume(Number($('music-volume').value) / 100); });
  $('music-background').onclick = safely(() => volume(.2));
  $('music-main').onclick = safely(() => volume(.85));
  $('music-loop').onchange = safely(async () => {
    const state = getRecording(); prefs.loop = $('music-loop').checked; player.loop = prefs.loop;
    if (active(state) && state.music) await send('loop', prefs.loop, state.sessionId);
    await persist(); render();
  });
  $('music-remove').onclick = safely(async () => {
    if ($('music-remove').disabled) return;
    setBusy(true);
    try { stopPreview(); await deleteMusic(prefs.id); prefs = { ...prefs, id: null, enabled: false }; await persist(); await refresh(); }
    finally { if (!disposed) setBusy(false); }
  });
  $('music-retry').onclick = safely(refresh);
  for (const event of ['play', 'pause', 'ended']) player.addEventListener(event, () => {
    if (disposed) return;
    if (event === 'ended' && !active(getRecording())) status('试听已结束，可从头播放。');
    render();
  });
  player.addEventListener('error', () => { if (!disposed && player.getAttribute('src')) { status('这首音乐无法播放，请换一个文件。'); player.pause(); render(); } });
  const changed = () => { dirty = true; if (busy || active(getRecording())) deferredRefresh = true; else if (expanded()) refresh().catch(problem); };
  if (channel) channel.onmessage = changed;
  const visible = () => { if (!document.hidden && expanded() && (dirty || !loaded)) refresh().catch(problem); else if (document.hidden) stopPreview(); };
  document.addEventListener('visibilitychange', visible);
  const toggle = () => {
    if (expanded()) { if (dirty || !loaded) refresh().catch(problem); }
    else { stopPreview(); ++refreshRevision; loading = false; }
  };
  $('music-card').addEventListener('toggle', toggle);
  const dispose = () => { if (disposed) return; disposed = true; ++refreshRevision; stopPreview(); channel?.close(); document.removeEventListener('visibilitychange', visible); };
  window.addEventListener('pagehide', dispose, { once: true });
  const ready = expanded() ? refresh().catch(problem) : Promise.resolve();
  render();
  return { ready, render, dispose, async beforeRecording() {
    stopPreview();
    if (!preferencesKnown || dirty) { prefs = { ...prefs, ...await getMusicPreferences() }; preferencesKnown = true; }
    if (!prefs.enabled || !prefs.id) return null;
    return musicConfig(prefs);
  } };
}
