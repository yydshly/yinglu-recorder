import { clockText, elapsed, fileSize } from './lib/geometry.js';
import { listRecordingPage } from './lib/db.js';
import { chooseRecordingMime, isRecordingFormatSupported } from './lib/media-format.js';
import { prepareAnnotationImage } from './lib/image-annotation.js';
import { createMaterialShelf } from './lib/materials-panel.js';
import { createMusicPanel } from './lib/music-panel.js';
let imageController;
const $ = id => document.getElementById(id);
const extension = !!globalThis.chrome?.runtime?.id;
let state = { status: 'idle' }, crop = null, selecting = false, opening = false;
let selectionId = null, beginAttempt = 0, refreshAttempt = 0, targetTabId;
let connected = !extension, isCurrentTab = true, windowId, windowProblem;
let importingImage = false, imageDestination = null;
let materialShelf, materialBusy = false;
let musicShelf, musicBusy = false;
let clockTimer = null, enablingAutoConnect = false, reconnecting = false;
let panelClosed = false, followQueued = false;
const panelSubscriptions = [];
let permissionsKnown = false, autoConnectEnabled = false, needsAuthorization = false, authorizationNote = '';
let exportNoticeId, exportNoticeRevision = 0;
let settingsReady, settingsLoaded = !extension, settingsProblem = null;
const settingIds = ['audio', 'microphone', 'quality', 'fps', 'diagnostics', 'format'];
const changedSettings = new Set();
const settingKey = id => `setting_${id}`;
const saveSetting = (id, value) => { changedSettings.add(id); return extension ? chrome.storage.local.set({ [settingKey(id)]: value }) : Promise.resolve(); };
function updateFormat() {
  $('format-mp4').disabled = !isRecordingFormatSupported('mp4');
  if ($('format').value === 'mp4' && $('format-mp4').disabled) $('format').value = 'webm';
  $('format-hint').textContent = $('format-mp4').disabled ? '此浏览器暂不支持 MP4 录制，可使用 WebM。' : 'MP4 便于发布；WebM 是默认格式。也可录完后在录制库转换。';
}
function applySetting(id, value) {
  if ($(id).type === 'checkbox') $(id).checked = !!value; else $(id).value = value;
  if (id === 'format') updateFormat();
}
function loadSettings() {
  if (settingsReady && !settingsProblem) return settingsReady;
  settingsLoaded = false; settingsProblem = null;
  settingsReady = (async () => {
    let timer;
    try {
      const saved = await Promise.race([
        chrome.storage.local.get(['settings', ...settingIds.map(settingKey)]),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('读取设置超时')), 5000); })
      ]);
      for (const id of settingIds) {
        const value = saved[settingKey(id)] ?? saved.settings?.[id];
        if (value !== undefined && !changedSettings.has(id)) applySetting(id, value);
      }
      settingsLoaded = true;
    } catch (cause) {
      settingsProblem = new Error('读取录制设置失败，请点击网页信息右侧的 ↻ 刷新按钮重新连接。');
      settingsProblem.detail = cause?.message || String(cause);
      throw settingsProblem;
    } finally { clearTimeout(timer); render(); }
  })();
  return settingsReady;
}
updateFormat();
const isBusy = value => ['preparing', 'recording', 'paused', 'saving'].includes(value?.status);
const windowReady = (async () => {
  // Older test harnesses have no windows API. Real extension pages must resolve
  // their containing window; a worker's currentWindow can refer to another one.
  if (!extension || !chrome.windows) return;
  let timer;
  try {
    const current = await Promise.race([
      chrome.windows.getCurrent(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('获取窗口超时')), 3000); })
    ]);
    if (!Number.isInteger(current?.id) || current.id < 0) throw new Error('未找到侧栏所属窗口');
    windowId = current.id;
  } catch {
    windowProblem = '无法确定侧栏所属窗口，请关闭侧栏后在目标网页重新点击映录图标。';
  } finally { clearTimeout(timer); }
})();
const error = (message, detail) => {
  $('error').textContent = message || ''; $('error').hidden = !message;
  $('error-detail').textContent = detail || ''; $('error-details').hidden = !detail;
};
async function call(type, extra = {}) {
  if (!extension) {
    if (type === 'OVERLAY') parent.postMessage({ type: 'YINGLU_COMMAND', command: { type: extra.command, options: extra.options } }, location.origin);
    return { ok: true };
  }
  await windowReady;
  if (windowProblem) throw new Error(windowProblem);
  const pending = chrome.runtime.sendMessage({ target: 'background', type, windowId, tabId: targetTabId, ...extra });
  let result, timer;
  try {
    // Limit read/connect waits only. Capture mutations retain the worker's
    // session-aware cancellation and recovery instead of a UI-only timeout.
    const deadline = type === 'GET_STATE' ? 20000 : type === 'CONNECT' ? 15000 : 0;
    result = deadline ? await Promise.race([pending, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('网页连接暂未响应，请重试连接；若插件已刷新，请关闭并重新打开侧栏。')), deadline);
    })]) : await pending;
  } finally { clearTimeout(timer); }
  if (!result?.ok) {
    const problem = new Error(result?.error || '连接已断开，请重新打开侧栏'); problem.detail = result?.detail; problem.code = result?.code; throw problem;
  }
  return result;
}
function showProblem(cause) {
  if (cause.code === 'HOST_ACCESS_REQUIRED' && !isBusy(state)) {
    if (connected) return; // A late permission error must not replace a healthy connection.
    permissionsKnown = true; needsAuthorization = true; authorizationNote = '';
    error(null); render();
  } else error(cause.message, cause.detail);
}
async function safe(fn) { try { error(null); await fn(); } catch (e) { showProblem(e); } }
function setTool(tool) {
  document.querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('active', b.dataset.tool === tool); b.setAttribute('aria-pressed', String(b.dataset.tool === tool)); });
  $('text-options').hidden = !['text', 'select'].includes(tool);
  $('tool-hint').textContent = tool === 'pointer' ? '当前可正常点击、滚动网页。侧栏不会录入网页视频。' : tool === 'select' ? '点击图形可移动，拖动右下角可缩放。双击文字可编辑。' : tool === 'text' ? '点击网页输入，点击框外完成；选择「操作网页」继续演示。' : '在网页上拖动绘制；完成后点击「操作网页」继续演示。';
}
function render() {
  updateClock();
  const busy = ['preparing', 'recording', 'paused', 'saving'].includes(state.status) || selecting || opening || reconnecting || enablingAutoConnect;
  const awaitingPermission = needsAuthorization && !connected && !isBusy(state) && !selecting && !opening && !reconnecting;
  const active = ['recording', 'paused'].includes(state.status);
  document.body.classList.toggle('recording', state.status === 'recording');
  document.body.classList.toggle('paused', state.status === 'paused');
  document.querySelectorAll('.setup-card button,.setup-card input,.setup-card select').forEach(e => e.disabled = busy);
  $('start').hidden = active || selecting || state.status === 'preparing';
  $('start').disabled = busy || !connected || !settingsLoaded;
  $('start').disabled ||= importingImage || materialBusy || musicBusy;
  $('add-image').disabled = importingImage || materialBusy || musicBusy || !connected || !isCurrentTab || selecting || opening || ['preparing', 'saving'].includes(state.status);
  $('add-image').textContent = importingImage ? '正在添加图片…' : '▧ 添加图片';
  $('pause').hidden = !active;
  $('review-recording').hidden = !state.id || !['complete', 'interrupted'].includes(state.status);
  $('stop').hidden = !active && !selecting && !['preparing', 'saving'].includes(state.status);
  $('pause').textContent = state.status === 'paused' ? '继续录制' : '暂停';
  $('stop').textContent = selecting ? '取消框选' : state.status === 'preparing' ? '取消连接' : state.status === 'saving' ? '强制结束' : '结束录制';
  if (!selecting) {
    const label = enablingAutoConnect ? '等待 Chrome 授权' : awaitingPermission && !state.error && !settingsProblem ? '等待网页授权'
      : { recording: '正在录制', paused: '已暂停', saving: '正在保存', preparing: '连接画面中', complete: '已保存到录制库', interrupted: '部分保存，请回看', error: '需要处理' }[state.status] || '准备就绪';
    $('status-label').replaceChildren();
    const dot = document.createElement('i'); dot.className = 'status-dot';
    $('status-label').append(dot, ` ${label}`);
    $('start').innerHTML = '<span class="record-dot"></span>' + (awaitingPermission ? '先开启自动连接' : state.status === 'saving' ? '正在保存…' : state.status === 'preparing' ? '正在连接…' : '开始录制');
  }
  document.querySelectorAll('.tools button,.drawing-options button,.drawing-options select,.edit-actions button,#font-size,#restore-annotations,#clicks').forEach(e => e.disabled = !connected || !isCurrentTab || selecting || opening || ['preparing', 'saving'].includes(state.status));
  $('reconnect').disabled = busy || !!windowProblem;
  $('reconnect').setAttribute('aria-busy', String(reconnecting));
  $('reconnect').classList.toggle('is-refreshing', reconnecting);
  $('auto-connect').disabled = busy || enablingAutoConnect || !!windowProblem;
  $('auto-connect-guide').hidden = !extension || !permissionsKnown || autoConnectEnabled && !needsAuthorization;
  $('auto-connect').hidden = $('auto-connect-hint').hidden = $('auto-connect-guide').hidden;
  $('auto-connect').classList.toggle('permission-needed', needsAuthorization);
  $('auto-connect').textContent = enablingAutoConnect ? '请在 Chrome 弹窗中允许…' : '开启自动连接网页';
  $('auto-connect-title').textContent = needsAuthorization ? '首次使用，先开启自动连接' : '开启自动连接，方便切换网页';
  $('auto-connect-hint').textContent = authorizationNote || '点击按钮，在 Chrome 弹窗中选择「允许」，以后切换网页会自动连接。录制仍由你开始。';
  if (awaitingPermission) $('connection-label').textContent = enablingAutoConnect ? '等待授权，请在 Chrome 弹窗中选择「允许」。' : '等待授权，请先开启下方的自动连接。';
  if (isBusy(state) && !isCurrentTab) $('tool-hint').textContent = '录制仍锁定原网页。请切回该网页后标注；暂停和结束仍可使用。';
  else if (!connected) $('tool-hint').textContent = needsAuthorization ? '先开启自动连接网页，允许后即可使用标注和录制。' : '连接未完成，可点击网页信息旁的 ↻ 重试。';
  if (windowProblem) $('connection-label').textContent = windowProblem;
  if (selecting) $('status-label').textContent = '请在网页拖动框选，松开即开始';
  if (state.error) error(state.error, state.detail);
  else if (state.restoreError) error(state.restoreError);
  if (settingsProblem) error(settingsProblem.message, settingsProblem.detail);
  materialShelf?.render();
  musicShelf?.render();
}
async function refresh() {
  if (!extension || document.hidden) return;
  const attempt = ++refreshAttempt;
  let result;
  try { result = await call('GET_STATE'); }
  catch (cause) {
    if (attempt !== refreshAttempt) return;
    connected = false; $('connected').classList.toggle('live', false);
    if (!isBusy(state)) { $('page-title').textContent = '网页信息获取失败'; $('page-host').textContent = '点击右侧 ↻ 重新获取'; }
    $('connection-label').textContent = '网页连接未完成，可点 ↻ 重试连接。'; render();
    throw cause;
  }
  if (attempt !== refreshAttempt) return;
  const target = result.targetTab;
  const previousTabId = targetTabId;
  const changedTarget = previousTabId !== undefined && target?.id !== previousTabId;
  let oldSelection;
  if (changedTarget || (opening || selecting) && !result.connected) {
    if (selecting && selectionId) oldSelection = { id: selectionId, tabId: previousTabId };
    if ($('range-dialog').open) $('range-dialog').close();
    opening = false; selecting = false; selectionId = null; crop = null;
    $('crop-label').hidden = true;
    ++beginAttempt;
  }
  state = result.recording || { status: 'idle' }; crop = result.crop;
  isCurrentTab = result.isCurrentTab !== false;
  connected = !!result.connected && isCurrentTab;
  permissionsKnown = true; autoConnectEnabled = !!result.autoConnectEnabled;
  needsAuthorization = !connected && isCurrentTab && !result.pageLoading && !target?.url?.startsWith('file:')
    && (!!result.needsActivation || result.connection?.status === 'needs-activation');
  if (connected || changedTarget) authorizationNote = '';
  targetTabId = target?.id;
  let host = '';
  try { host = new URL(target.url).hostname; } catch { /* Chrome may withhold page metadata until access is granted. */ }
  const knownTab = Number.isInteger(target?.id);
  $('page-title').textContent = target?.title || host || (knownTab ? result.pageLoading ? '正在加载当前网页…' : result.needsActivation ? '当前网页待授权'
    : connected ? '当前网页' : result.connection?.status === 'connecting' ? '正在连接当前网页…' : '当前网页尚未连接' : '未找到当前网页');
  $('page-host').textContent = host || (knownTab ? result.pageLoading ? '地址就绪后自动连接' : result.needsActivation ? '点击下方「开启自动连接网页」'
    : '点击右侧 ↻ 重新获取当前网页' : '切回要录制的网页后点击 ↻');
  $('connected').classList.toggle('live', connected);
  $('connection-label').textContent = isBusy(state) && !isCurrentTab ? '录制仍锁定原网页，请切回该网页进行标注。'
    : connected ? '已连接当前网页，可使用标注'
    : result.pageLoading ? '网页正在加载，地址就绪后自动连接'
    : result.connection?.status === 'connecting' ? '正在连接网页…'
    : needsAuthorization ? '等待授权，请先开启下方的自动连接。'
    : result.connection?.status === 'error' ? '连接失败，可点右侧 ↻ 重试' : '当前网页尚未连接，可点右侧 ↻ 获取';
  $('version').textContent = result.version || '0.6.9';
  if (result.overlay?.options) {
    const o = result.overlay.options; setTool(o.tool);
    $('width').value = String(o.width); $('font-size').value = String(o.fontSize || 28);
    document.querySelectorAll('[data-color]').forEach(b => { b.classList.toggle('active', b.dataset.color === o.color); b.setAttribute('aria-pressed', String(b.dataset.color === o.color)); });
  } else setTool('pointer');
  $('restore-annotations').hidden = !result.overlay?.archived;
  error(null);
  render();
  if (!connected && isCurrentTab && result.connection?.error && !needsAuthorization) error(result.connection.error, result.connection.detail);
  else if (result.warning) error(result.warning);
  if (state.id && !isBusy(state)) refreshExportNotice(state.id).catch(() => {});
  // Cancel only this panel's old selection, never another window's new one.
  if (oldSelection) call('OVERLAY', { command: 'CANCEL_CROP', tabId: oldSelection.tabId,
    options: { selectionId: oldSelection.id } }).catch(() => {});
  return result;
}
async function library() {
  if (!extension) return;
  const { records } = await listRecordingPage({ limit: 3 });
  $('recent-list').replaceChildren();
  if (!records.length) return;
  records.forEach(r => {
    const link = document.createElement('a'); link.className = 'recent-item';
    link.href = `library.html?id=${encodeURIComponent(r.id)}`; link.target = '_blank';
    link.textContent = r.title;
    const meta = document.createElement('small'); meta.textContent = `${clockText(r.duration)} · ${fileSize(r.bytes)} · ${r.status === 'complete' ? '已完成' : '录制中或待恢复'}`;
    link.append(meta); $('recent-list').append(link);
  });
  if (!state.id && !isBusy(state)) refreshExportNotice(records[0].id).catch(() => {});
}
function openPage(path) { if (extension) chrome.tabs.create({ url: chrome.runtime.getURL(path) }); else window.open(path, '_blank'); }
function showExportNotice(recordingId, value) {
  if (isBusy(state) && state.id !== recordingId || state.id && state.id !== recordingId) return;
  exportNoticeId = recordingId;
  const metric = value?.progress || value;
  const status = value?.status === 'error' && String(value.error || '').startsWith('已取消') ? 'cancelled' : value?.status === 'preparing' && metric?.phase === 'converting' ? 'converting' : value?.status;
  const label = { queued: '视频等待导出', preparing: '正在准备导出视频', converting: '视频正在本机转换', downloading: '视频正在下载', complete: '视频已导出到本机', error: '导出失败，可到录制库重试；本地片段仍保留', cancelled: '已取消导出，原视频保留' }[status];
  const progress = Number.isFinite(metric?.percent) ? ` · ${Math.max(0, Math.min(100, metric.percent)).toFixed(0)}%` : '';
  $('export-notice').textContent = label ? label + progress + (value?.cleanupPending ? ' · 正在结束本机文件读写，请稍后再试' : '') : ''; $('export-notice').hidden = !label;
  $('cancel-export').hidden = !['queued', 'preparing', 'converting', 'downloading'].includes(value?.status);
}
async function refreshExportNotice(recordingId) {
  const revision = exportNoticeRevision;
  const result = await call('GET_EXPORT_STATE', { recordingId });
  if (revision === exportNoticeRevision && result.export) showExportNotice(recordingId, result.export);
}
$('cancel-export').onclick = () => safe(async () => {
  if (!exportNoticeId) return;
  const result = await call('EXPORT_CANCEL', { recordingId: exportNoticeId });
  if (result.export) showExportNotice(exportNoticeId, result.export);
});
$('library').onclick = $('all-recordings').onclick = () => openPage('library.html');
$('review-recording').onclick = () => {
  if (state.id && ['complete', 'interrupted'].includes(state.status)) openPage(`library.html?id=${encodeURIComponent(state.id)}`);
};
$('desktop').onclick = () => openPage('desktop.html');
const captureImageDestination = () => ({ tabId: targetTabId, sessionId: state.sessionId, active: isBusy(state), region: state.cropViewport ? crop : null });
const canInsertImage = () => connected && isCurrentTab && !selecting && !opening && !['preparing', 'saving'].includes(state.status);
async function insertPreparedImage(image, destination) {
  const { tabId, sessionId, active, region } = destination;
  if (tabId !== targetTabId || sessionId !== state.sessionId || active !== isBusy(state) || !canInsertImage()) throw new Error('网页或录制状态已变化，请在目标网页重新添加图片。');
  await call('OVERLAY', { tabId, command: 'INSERT_IMAGE', options: { image, region, sessionId: active ? sessionId : null } });
  setTool('select');
  $('tool-hint').textContent = '图片已添加。拖动调整位置，右下角等比缩放；选择「操作网页」收起边框。';
}
$('add-image').onclick = () => {
  if ($('add-image').disabled) return;
  imageDestination = captureImageDestination();
  $('image-file').value = ''; $('image-file').click();
};
$('image-file').onchange = () => safe(async () => {
  const file = $('image-file').files?.[0];
  if (!file || importingImage || !connected || !isCurrentTab || selecting || opening || ['preparing', 'saving'].includes(state.status)) return;
  // A file picker or decoding can outlive a tab/session change. Keep this
  // image bound to the page and recording the user selected it for.
  const destination = imageDestination; imageDestination = null;
  if (!destination) return;
  importingImage = true; render();
  imageController = new AbortController();
  try {
    const image = await prepareAnnotationImage(file, { signal: imageController.signal });
    await insertPreparedImage(image, destination);
  } finally { imageController = null; importingImage = false; $('image-file').value = ''; if (!panelClosed) render(); }
});
materialShelf = createMaterialShelf({
  canImport: () => !isBusy(state) && !selecting && !opening && !importingImage && !musicBusy,
  canUse: () => canInsertImage() && !importingImage,
  captureDestination: captureImageDestination,
  insert: insertPreparedImage,
  onBusy: value => { materialBusy = value; render(); },
  onError: cause => error(cause.message, cause.detail)
});
musicShelf = createMusicPanel({ getRecording: () => state,
  canImport: () => !isBusy(state) && !selecting && !opening && !importingImage && !materialBusy,
  send: (command, value, sessionId) => call('MUSIC', { command, value, sessionId }),
  onBusy: value => { musicBusy = value; render(); }, onError: cause => error(cause.message, cause.detail)
});
$('low-load').onclick = () => safe(async () => {
  if (isBusy(state) || !settingsLoaded) return;
  applySetting('quality', 'performance'); applySetting('fps', '20');
  await Promise.all([saveSetting('quality', 'performance'), saveSetting('fps', '20')]);
});
$('reconnect').onclick = () => safe(async () => {
  if (reconnecting || enablingAutoConnect || isBusy(state) || selecting || opening || windowProblem) return;
  reconnecting = true; ++refreshAttempt; connected = false;
  $('connected').classList.toggle('live', false);
  $('connection-label').textContent = '正在获取当前网页…'; render();
  try { if (extension) await loadSettings(); await call('CONNECT'); await refresh(); }
  catch (cause) {
    if (!isBusy(state)) {
      connected = false; $('connected').classList.toggle('live', false);
      $('connection-label').textContent = '获取失败，可点右侧 ↻ 重试';
    }
    throw cause;
  } finally { reconnecting = false; render(); }
});
$('auto-connect').onclick = () => {
  if (enablingAutoConnect || isBusy(state)) return;
  // Request synchronously in the actual button gesture. Never prompt while
  // following a tab, and never repeat a denied permission request on refresh.
  let permission;
  try { permission = chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }); }
  catch (cause) { error(cause.message); return; }
  enablingAutoConnect = true; render();
  return safe(async () => {
    try {
      if (!await permission) {
        authorizationNote = '暂未开启。需要时可再次点击，在 Chrome 弹窗中选择「允许」。';
        error(null); return;
      }
      authorizationNote = '';
      if (!isBusy(state)) await call('CONNECT');
      await refresh();
    } finally { enablingAutoConnect = false; render(); }
  });
};
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => safe(async () => {
  await call('OVERLAY', { command: 'SET', options: { tool: b.dataset.tool } }); setTool(b.dataset.tool);
}));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => safe(async () => {
  await call('OVERLAY', { command: 'SET', options: { color: b.dataset.color } });
  document.querySelectorAll('[data-color]').forEach(c => { c.classList.toggle('active', c === b); c.setAttribute('aria-pressed', String(c === b)); });
}));
for (const [id, command] of [['undo', 'UNDO'], ['redo', 'REDO'], ['clear', 'CLEAR'], ['delete-shape', 'DELETE']]) {
  $(id).onclick = () => safe(() => call('OVERLAY', { command }));
}
$('width').onchange = () => safe(() => call('OVERLAY', { command: 'SET', options: { width: Number($('width').value) } }));
$('font-size').onchange = () => safe(() => call('OVERLAY', { command: 'SET', options: { fontSize: Number($('font-size').value) } }));
$('restore-annotations').onclick = () => safe(async () => { const result = await call('OVERLAY', { command: 'RESTORE' }); if (!result.ignored) $('restore-annotations').hidden = true; });
$('clicks').onchange = () => safe(() => call('OVERLAY', { command: 'SET', options: { clicks: $('clicks').checked } }));
$('microphone').onchange = () => safe(async () => {
  if (!$('microphone').checked || !extension) return;
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true }); mic.getTracks().forEach(t => t.stop());
  } catch {
    $('microphone').checked = false;
    await saveSetting('microphone', false);
    openPage('microphone.html');
    throw new Error('已打开麦克风授权页。允许后回到项目网页，再勾选麦克风。');
  }
});
async function begin(range, selectedId = null) {
  if (['preparing', 'recording', 'paused', 'saving'].includes(state.status)) return;
  selecting = false; opening = false; selectionId = null;
  const attempt = ++beginAttempt;
  ++refreshAttempt;
  if (!extension) {
    render();
    throw new Error(range === 'region' ? '框选完成。这是交互预览；实际录制请在 Chrome 中加载插件。' : '范围选择完成。这是交互预览；实际录制请在 Chrome 中加载插件。');
  }
  try {
    await settingsReady;
    const music = await musicShelf.beforeRecording();
    if (attempt !== beginAttempt || isBusy(state)) return;
    chooseRecordingMime($('format').value || 'webm');
    state = { status: 'preparing' }; $('export-notice').hidden = true; $('cancel-export').hidden = true; render();
    await call('START', { selectionId: selectedId, options: { range, fps: Number($('fps').value), quality: $('quality').value,
      audio: $('audio').checked, microphone: $('microphone').checked, clicks: $('clicks').checked,
      diagnostics: $('diagnostics').checked, format: $('format').value || 'webm', music } });
    if (attempt === beginAttempt) { setTool('pointer'); await refresh(); }
  } catch (e) { if (attempt === beginAttempt) state = { status: 'error' }; throw e; }
  finally { if (attempt === beginAttempt) render(); }
}
$('start').onclick = () => safe(async () => {
  if (!settingsLoaded || reconnecting || opening || selecting || ['preparing', 'recording', 'paused', 'saving'].includes(state.status)) return;
  ++beginAttempt;
  opening = true; render();
  try {
    if (extension) { await refresh(); if (!connected) throw new Error('网页未连接，请在目标网页上点击映录图标。'); }
    if (isBusy(state)) { opening = false; render(); return; }
    opening = true; render();
    $('range-dialog').showModal();
  } catch (e) { opening = false; render(); throw e; }
});
function closeChooser() { $('range-dialog').close(); opening = false; render(); }
$('cancel-range').onclick = closeChooser;
$('range-dialog').addEventListener('cancel', () => { opening = false; render(); });
$('record-full').onclick = () => safe(async () => { closeChooser(); crop = null; $('crop-label').hidden = true; await begin('full'); });
$('record-region').onclick = () => safe(async () => {
  closeChooser(); selecting = true; crop = null; selectionId = crypto.randomUUID(); render();
  const id = selectionId;
  try { await call('OVERLAY', { command: 'CROP', options: { selectionId: id } }); }
  catch (e) { if (selectionId === id) { selecting = false; selectionId = null; render(); } throw e; }
});
async function selectedArea(area, id, tabId) {
  if (!selecting || !id || id !== selectionId || extension && targetTabId !== undefined && tabId !== targetTabId) return;
  crop = area; $('crop-label').hidden = false;
  $('crop-label').textContent = `框选 ${Math.round(area.width * area.viewportWidth)} × ${Math.round(area.height * area.viewportHeight)}`;
  await begin('region', id);
}
$('pause').onclick = () => safe(() => call(state.status === 'paused' ? 'RESUME' : 'PAUSE', { sessionId: state.sessionId }));
$('stop').onclick = () => safe(async () => {
  if (selecting) {
    const id = selectionId; selecting = false; selectionId = null; render();
    await call('OVERLAY', { command: 'CANCEL_CROP', options: { selectionId: id } }); setTool('pointer'); return;
  }
  await call(state.status === 'saving' ? 'FORCE_STOP' : 'STOP', { sessionId: state.sessionId });
});
function updateClock() {
  const value = clockText(['complete', 'interrupted'].includes(state.status) ? state.duration : elapsed(state));
  if ($('timer').textContent !== value) $('timer').textContent = value;
  const running = state.status === 'recording' && !document.hidden;
  if (!running && clockTimer !== null) { clearInterval(clockTimer); clockTimer = null; }
  if (running && clockTimer === null) clockTimer = setInterval(updateClock, 1000);
}
async function followCurrentPage(info = {}) {
  if (!extension || panelClosed || document.hidden) return;
  await windowReady;
  if (panelClosed || document.hidden || windowProblem || info.windowId !== undefined && info.windowId !== windowId) return;
  ++refreshAttempt;
  if (info.tabId !== undefined && info.tabId !== targetTabId && !isBusy(state)) {
    connected = false; $('connected').classList.toggle('live', false);
    $('connection-label').textContent = '正在识别当前网页…'; render();
  }
  if (followQueued) return;
  followQueued = true;
  queueMicrotask(() => {
    followQueued = false;
    if (!panelClosed && !document.hidden) safe(refresh);
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) ++refreshAttempt;
  updateClock();
  if (!document.hidden && extension) safe(refresh);
});
window.addEventListener('pagehide', () => {
  panelClosed = true; imageController?.abort(); ++refreshAttempt;
  if (clockTimer !== null) clearInterval(clockTimer); clockTimer = null;
  for (const unsubscribe of panelSubscriptions) unsubscribe();
});
if (extension) {
  // Extension pages can receive Tabs events directly. Following a tab should
  // not depend on a worker-to-panel broadcast reaching the visible document.
  const directActivation = !!chrome.tabs.onActivated?.addListener;
  const directUpdates = !!chrome.tabs.onUpdated?.addListener;
  const subscribe = (event, listener) => {
    event.addListener(listener); panelSubscriptions.push(() => event.removeListener?.(listener));
  };
  if (directActivation) subscribe(chrome.tabs.onActivated, info => { followCurrentPage(info); });
  if (directUpdates) subscribe(chrome.tabs.onUpdated, (id, change, tab) => {
    if (!tab?.active || tab.windowId !== windowId || panelClosed || document.hidden) return;
    if (change.url || change.status || change.discarded !== undefined || !connected && change.title !== undefined)
      followCurrentPage({ windowId: tab.windowId, tabId: id });
    else if (id === targetTabId && change.title !== undefined && tab.title) $('page-title').textContent = tab.title;
  });
  window.addEventListener('focus', () => { followCurrentPage(); });
  chrome.runtime.onMessage.addListener(message => {
    if (message.target !== 'panel') return;
    if (!['STATE', 'EXPORT_STATE'].includes(message.type) && message.windowId !== undefined && message.windowId !== windowId) return;
    if (message.type === 'STATE') {
      const previous = state;
      const controls = value => JSON.stringify([value.status, value.id, value.sessionId, value.tabId, value.error, value.detail, value.restoreError, value.released, value.music]);
      const changed = controls(previous) !== controls(message.state);
      ++refreshAttempt; state = message.state;
      const differentSource = isBusy(state) && state.tabId !== undefined && state.tabId !== targetTabId;
      if (differentSource) { connected = false; isCurrentTab = false; }
      if (changed && (differentSource || state.released || ['complete', 'interrupted', 'error', 'cancelled'].includes(state.status))) { setTool('pointer'); safe(refresh); }
      if (changed) render(); else updateClock();
      if (['complete', 'interrupted'].includes(state.status) && (previous.id !== state.id || previous.status !== state.status)) library().catch(showProblem);
    }
    if (message.type === 'PAGE_TITLE' && message.tabId === targetTabId && message.title && $('page-title').textContent !== message.title) $('page-title').textContent = message.title;
    if (message.type === 'CROP_READY') safe(() => selectedArea(message.crop, message.selectionId, message.tabId));
    if (message.type === 'CROP_CANCEL' && message.selectionId === selectionId) { selecting = false; selectionId = null; setTool('pointer'); render(); }
    if (message.type === 'TOOL_CHANGED' && connected && isCurrentTab && (targetTabId === undefined || message.tabId === targetTabId)) setTool(message.options.tool);
    if (message.type === 'ANNOTATION_ERROR' && connected && message.tabId === targetTabId) error(message.error);
    if (message.type === 'REFRESH') {
      if (message.reason === 'tab-activated' && directActivation || message.reason === 'tab-updated' && directUpdates) return;
      if (document.hidden && !isBusy(state)) { ++refreshAttempt; return; }
      if (message.tabId !== undefined && message.tabId !== targetTabId && !isBusy(state)) {
        connected = false; $('connection-label').textContent = '正在识别当前网页…'; render();
      }
      safe(refresh);
    }
    if (message.type === 'EXPORT_STATE') { exportNoticeRevision++; showExportNotice(message.recordingId, message.export); }
    if (message.type === 'ERROR') {
      if (message.code === 'HOST_ACCESS_REQUIRED' && message.tabId !== undefined && targetTabId !== undefined && message.tabId !== targetTabId) return;
      showProblem({ message: message.error, detail: message.detail, code: message.code });
    }
  });
  settingIds.forEach(id => $(id).addEventListener('change', () => {
    safe(() => saveSetting(id, $(id).type === 'checkbox' ? $(id).checked : $(id).value));
  }));
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const id of settingIds) if (changes[settingKey(id)]?.newValue !== undefined) { changedSettings.add(id); applySetting(id, changes[settingKey(id)].newValue); }
  });
  render();
  const initialBeginAttempt = beginAttempt;
  safe(async () => {
    await loadSettings();
    await windowReady;
    if (windowProblem) { render(); throw new Error(windowProblem); }
    const initial = await refresh();
    if (beginAttempt === initialBeginAttempt && !opening && !selecting && !isBusy(state) && initial?.overlay?.cropMode && initial.overlay.selectionId) {
      await call('OVERLAY', { tabId: initial.targetTab?.id, command: 'CANCEL_CROP', options: { selectionId: initial.overlay.selectionId } });
    }
    await library();
  });
} else {
  $('demo-notice').hidden = false;
  $('page-title').textContent = '交互体验 · 一个安静的骑行午后'; $('page-host').textContent = '预览画布'; $('connected').classList.add('live');
  $('connection-label').textContent = '交互预览已连接';
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== parent || e.data?.type !== 'YINGLU_EVENT') return;
    if (e.data.event.type === 'CROP') safe(() => selectedArea(e.data.event.crop, e.data.event.selectionId));
    if (e.data.event.type === 'CROP_CANCEL' && e.data.event.selectionId === selectionId) { selecting = false; selectionId = null; setTool('pointer'); render(); }
    if (e.data.event.type === 'TOOL_CHANGED') setTool(e.data.event.options.tool);
    if (e.data.event.type === 'ANNOTATION_ERROR') error(e.data.event.error);
  });
  render();
}
