import { Recorder } from './lib/recorder.js';
import { clockText, elapsed, normalizeRect } from './lib/geometry.js';
import { chooseRecordingMime, isRecordingFormatSupported } from './lib/media-format.js';
const $ = id => document.getElementById(id);
let stream, crop = null, drag, ownerTabId, attempt, choosing = false, stateWrites = Promise.resolve();
let previewSession = null, pendingPreview = null, pageClosed = false;
let exportRevision = 0;
let clockTimer = null;
const changedSettings = new Set();
const extension = !!globalThis.chrome?.runtime?.id;
const documentToken = crypto.randomUUID();
if (extension) ownerTabId = (await chrome.tabs.getCurrent()).id;
const error = e => { $('error').textContent = e?.message || ''; $('error').hidden = !e; };
function updateFormat() {
  $('format-mp4').disabled = !isRecordingFormatSupported('mp4');
  if ($('format').value === 'mp4' && $('format-mp4').disabled) $('format').value = 'webm';
  $('format-hint').textContent = $('format-mp4').disabled ? '此浏览器暂不支持 MP4 录制，可使用 WebM。' : 'MP4 便于发布；也可录完后在录制库转换。';
}
updateFormat();
const settingsReady = (async () => {
  if (!extension || !chrome.storage?.local) return;
  try {
    const saved = await chrome.storage.local.get(['settings', 'setting_format']);
    const format = saved.setting_format ?? saved.settings?.format;
    if (format !== undefined && !changedSettings.has('format')) $('format').value = format;
    updateFormat();
  } catch (cause) { error(cause); }
})();
$('format').onchange = async () => {
  changedSettings.add('format');
  if (!extension || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.set({ setting_format: $('format').value });
  } catch (cause) { error(cause); }
};
if (extension) chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.setting_format?.newValue !== undefined) { changedSettings.add('format'); $('format').value = changes.setting_format.newValue; updateFormat(); }
});
const sourceReady = () => !!stream?.getVideoTracks().some(track => track.readyState === 'live');
async function request(type, data = {}) {
  if (!extension) return { ok: true };
  const response = await chrome.runtime.sendMessage({ target: 'background', type, tabId: ownerTabId, documentToken, ...data });
  if (!response?.ok) throw new Error(response?.error || '录制控制连接已断开，请刷新后重试');
  return response;
}
function releaseSource(releasePreview = true) {
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  $('source').pause(); $('source').srcObject = null; $('stage').hidden = true;
  if (releasePreview && previewSession) {
    const sessionId = previewSession; previewSession = null;
    return request('DESKTOP_PREVIEW_RELEASE', { sessionId }).catch(error);
  }
}
function render(state = recorder.state) {
  updateClock(state);
  const active = ['recording', 'paused'].includes(state.status);
  const preparing = !!attempt || state.status === 'preparing';
  const busy = active || preparing || choosing || state.status === 'saving';
  $('choose').disabled = busy; $('start').disabled = busy || !sourceReady();
  $('full').disabled = busy || !sourceReady();
  for (const id of ['audio', 'mic', 'quality', 'fps', 'format']) $(id).disabled = busy;
  $('release-source').disabled = busy || !sourceReady();
  $('crop').style.pointerEvents = busy ? 'none' : 'auto';
  $('pause').hidden = !active; $('stop').hidden = !(active || preparing || state.status === 'saving');
  $('stop').textContent = preparing ? '取消准备' : state.status === 'saving' ? '强制结束' : '结束并保存';
  $('pause').textContent = state.status === 'paused' ? '继续' : '暂停';
  $('status').textContent = preparing ? '正在连接' : { recording: '正在录制', paused: '已暂停', saving: '正在保存', complete: '已保存', interrupted: '部分保存', cancelled: '已取消', error: '录制失败' }[state.status] || '准备就绪';
}
const recorder = new Recorder(state => {
  if (extension && state.sessionId) {
    // Preserve state order across asynchronous runtime messages.
    stateWrites = stateWrites.then(() => request('DESKTOP_STATE', { state: { ...state, ownerTabId } })).catch(error);
  }
  render(state);
  if (state.error) error(new Error(state.error));
  if (state.status === 'preparing') { $('source').pause(); $('source').srcObject = null; $('stage').hidden = true; }
  if (state.released) releaseSource();
  if (['complete', 'interrupted'].includes(state.status)) {
    const link = document.createElement('a'); link.href = `library.html?id=${encodeURIComponent(state.id)}`; link.textContent = '回看录制 ↗';
    $('result').replaceChildren(link); $('start').disabled = true; $('stage').hidden = true;
    if (extension) {
      const revision = exportRevision;
      stateWrites.then(() => request('GET_EXPORT_STATE', { recordingId: state.id })).then(response => {
        if (revision === exportRevision && response.export) showExportNotice(state.id, response.export);
      }).catch(() => {});
    }
  }
});
function showExportNotice(recordingId, value) {
  if (recordingId !== recorder.state.id) return;
  const metric = value?.progress || value;
  const status = value?.status === 'error' && String(value.error || '').startsWith('已取消') ? 'cancelled' : value?.status === 'preparing' && metric?.phase === 'converting' ? 'converting' : value?.status;
  const label = { queued: '视频等待导出', preparing: '正在准备导出视频', converting: '视频正在本机转换', downloading: '视频正在下载', complete: '视频已导出到本机', error: '导出失败，可到本地录制库重试；本地片段仍保留', cancelled: '已取消导出，原视频保留' }[status];
  const progress = Number.isFinite(metric?.percent) ? ` · ${Math.max(0, Math.min(100, metric.percent)).toFixed(0)}%` : '';
  $('export-notice').textContent = label ? label + progress : ''; $('export-notice').hidden = !label;
  $('cancel-export').hidden = !['queued', 'preparing', 'converting', 'downloading'].includes(value?.status);
}
if (extension) chrome.runtime.onMessage?.addListener((message, sender, reply) => {
  if (message.target === 'desktop' && message.type === 'STATUS') {
    if (sender?.id !== chrome.runtime.id || sender.tab || message.tabId !== ownerTabId) return;
    reply({ ok: true, documentToken, closed: pageClosed,
      sessionId: attempt?.sessionId || previewSession || pendingPreview || recorder.state.sessionId,
      state: { ...recorder.state }, sourceActive: sourceReady() });
    return;
  }
  if (message.type !== 'EXPORT_STATE') return;
  exportRevision++; showExportNotice(message.recordingId, message.export);
});
if (extension) request('DESKTOP_READY').then(({ recovered }) => {
  if (!recovered?.id || pageClosed || attempt || choosing) return;
  const link = document.createElement('a'); link.href = `library.html?id=${encodeURIComponent(recovered.id)}`;
  link.textContent = '查看上次录制已保存的片段 ↗'; $('result').replaceChildren(link);
  if (recovered.error) error(new Error(recovered.error));
}).catch(error);
$('cancel-export').onclick = () => request('EXPORT_CANCEL', { recordingId: recorder.state.id }).then(response => {
  if (response.export) showExportNotice(recorder.state.id, response.export);
}).catch(error);
$('release-source').onclick = async () => {
  if (choosing || attempt || ['preparing', 'recording', 'paused', 'saving'].includes(recorder.state.status)) return;
  await releaseSource(); crop = null; $('range-label').textContent = '已释放来源'; render();
};
$('choose').onclick = async () => {
  if (choosing || attempt || ['preparing', 'recording', 'paused', 'saving'].includes(recorder.state.status)) return;
  choosing = true; render();
  let selected, acquired = false;
  const sessionId = previewSession || crypto.randomUUID(); pendingPreview = sessionId;
  // Start the lock request synchronously, keeping the display picker in this
  // click's user activation. A denied lock immediately stops any returned stream.
  const acquisition = request('DESKTOP_PREVIEW_ACQUIRE', { sessionId }).then(() => {
    acquired = true;
    if (pageClosed) request('DESKTOP_PREVIEW_RELEASE', { sessionId }).catch(() => {});
  }, cause => ({ error: cause }));
  try {
    error(null);
    // Must run directly within the user's click, before other awaited work.
    selected = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: Number($('fps').value), max: Number($('fps').value) } }, audio: $('audio').checked, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' });
    const lock = await acquisition;
    if (lock?.error) throw lock.error;
    if (pageClosed) throw new DOMException('页面已关闭', 'AbortError');
    releaseSource(false); previewSession = sessionId; stream = selected; crop = null;
    $('source').srcObject = stream; await $('source').play();
    $('stage').hidden = false; $('start').disabled = false; $('full').disabled = false;
    $('range-label').textContent = '完整画面 · 可在下方拖动框选'; $('result').replaceChildren();
    const selectedStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (selectedStream !== stream) return;
      if (recorder.state.status === 'preparing') recorder.stop();
      if (!['preparing', 'recording', 'paused', 'saving'].includes(recorder.state.status)) releaseSource();
      render(); $('stage').hidden = true;
    });
    if ($('audio').checked && !stream.getAudioTracks().length) error(new Error('此来源没有共享声音。可取消勾选“来源声音”后录制，或重新选择来源并开启声音共享。'));
    paint();
  } catch (e) {
    if (selected === stream) releaseSource();
    else selected?.getTracks().forEach(track => track.stop());
    await acquisition;
    if (acquired && previewSession !== sessionId) await request('DESKTOP_PREVIEW_RELEASE', { sessionId }).catch(() => {});
    error(new Error(e.name === 'NotAllowedError' ? '已取消选择，或浏览器没有获得录屏权限。' : e.message));
  }
  finally { pendingPreview = null; choosing = false; render(); }
};
function paint() {
  const canvas = $('crop'), video = $('source');
  canvas.width = video.videoWidth || 1280; canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');
  if (!crop) return;
  const x = crop.x * canvas.width, y = crop.y * canvas.height, w = crop.width * canvas.width, h = crop.height * canvas.height;
  ctx.fillStyle = '#10241a77'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.clearRect(x, y, w, h);
  ctx.strokeStyle = '#77e1ae'; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
}
const point = e => { const b = $('crop').getBoundingClientRect(); return { x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)) }; };
$('crop').onpointerdown = e => { drag = point(e); $('crop').setPointerCapture(e.pointerId); };
$('crop').onpointermove = e => {
  if (!drag) return; const b = $('crop').getBoundingClientRect(); crop = normalizeRect(drag, point(e), b.width, b.height); paint();
};
$('crop').onpointerup = e => {
  if (!drag) return; drag = null; $('crop').releasePointerCapture(e.pointerId);
  if (!crop || crop.width * $('source').videoWidth < 24 || crop.height * $('source').videoHeight < 24) crop = null;
  $('range-label').textContent = crop ? `${Math.round(crop.width * $('source').videoWidth)} × ${Math.round(crop.height * $('source').videoHeight)} · 已框选` : '完整画面'; paint();
};
$('crop').onpointercancel = () => { drag = null; };
$('full').onclick = () => { crop = null; $('range-label').textContent = '完整画面'; paint(); };
$('start').onclick = async () => {
  if (attempt || choosing || ['preparing', 'recording', 'paused', 'saving'].includes(recorder.state.status)) return;
  const current = { sessionId: previewSession || crypto.randomUUID(), cancelled: false, acquired: false };
  attempt = current; $('export-notice').hidden = true; $('cancel-export').hidden = true; render();
  try {
    error(null);
    if (!sourceReady()) throw new Error('请先选择有效的录制来源');
    if ($('audio').checked && !stream.getAudioTracks().length) throw new Error('此来源没有共享声音。请取消勾选“来源声音”，或重新选择来源并开启声音共享。');
    await settingsReady;
    if (current.cancelled) return;
    chooseRecordingMime($('format').value || 'webm');
    await request('DESKTOP_ACQUIRE', { sessionId: current.sessionId }); current.acquired = true;
    previewSession = null;
    if (current.cancelled) { await request('DESKTOP_RELEASE', { sessionId: current.sessionId }); return; }
    // Source acquisition and recording settings are separate steps. Exclude
    // source audio according to the latest checkbox, rather than stale picker settings.
    const recordingStream = new MediaStream([...stream.getVideoTracks(), ...($('audio').checked ? stream.getAudioTracks() : [])]);
    if (!$('audio').checked) stream.getAudioTracks().forEach(track => track.stop());
    await recorder.start(recordingStream, { crop, fps: Number($('fps').value), quality: $('quality').value, microphone: $('mic').checked, format: $('format').value || 'webm',
      title: stream.getVideoTracks()[0].label || '屏幕演示', context: { sessionId: current.sessionId, ownerTabId } });
  } catch (e) {
    if (e.name !== 'AbortError' && !current.cancelled) error(e);
    if (current.acquired) {
      await stateWrites;
      await request('DESKTOP_RELEASE', { sessionId: current.sessionId }).catch(error);
    }
  } finally { if (attempt === current) attempt = null; render(); }
};
$('pause').onclick = () => recorder.state.status === 'paused' ? recorder.resume() : recorder.pause();
$('stop').onclick = () => {
  const current = attempt;
  if (current) current.cancelled = true;
  recorder.stop();
  if (current && recorder.state.status !== 'preparing' && !['recording', 'paused', 'saving'].includes(recorder.state.status)) {
    releaseSource();
    if (attempt === current) attempt = null;
    render();
  }
};
function updateClock(state = recorder.state) {
  const value = clockText(['complete', 'interrupted', 'error', 'cancelled'].includes(state.status) ? state.duration || 0 : elapsed(state));
  if ($('timer').textContent !== value) $('timer').textContent = value;
  const running = !pageClosed && !document.hidden && state.status === 'recording';
  if (running && clockTimer === null) clockTimer = setInterval(() => updateClock(), 1000);
  if (!running && clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; }
}
document.addEventListener('visibilitychange', () => updateClock());
updateClock();
addEventListener('beforeunload', e => {
  if (attempt || ['preparing', 'recording', 'paused', 'saving'].includes(recorder.state.status)) { e.preventDefault(); e.returnValue = ''; }
});
addEventListener('pagehide', () => {
  pageClosed = true;
  updateClock();
  if (pendingPreview) request('DESKTOP_PREVIEW_RELEASE', { sessionId: pendingPreview }).catch(() => {});
  const sessionId = attempt?.sessionId || recorder.state.sessionId;
  if (attempt) attempt.cancelled = true;
  recorder.stop(); releaseSource();
  if (extension && sessionId) request('DESKTOP_RELEASE', { sessionId }).catch(() => {});
});
