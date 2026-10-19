import { connectionError, unsupportedPage, validateHandshake } from './lib/connection.js';
import { getRecording, patchRecording, deleteRecording } from './lib/db.js';
import { recoverStoppedRecording } from './lib/recovery.js';
import { AutoExporter } from './lib/auto-export.js';
import { appendDiagnostic, diagnosticSample } from './lib/page-diagnostics.js';
import { musicConfig } from './lib/music-store.js';

let creating;
let starting = false;
let connectionAttempt = 0;
const attachments = new Map();
const automaticFailures = new Map();
const liveConnections = new Set();
const autoConnectOrigins = ['http://*/*', 'https://*/*'];
let stateQueue = Promise.resolve();
let closingRecorder = false;
let startAttempt;
let stopWatchdog;
const exportReservations = new Set();
const deletingRecordings = new Set();
const terminal = state => ['complete', 'interrupted', 'error', 'cancelled'].includes(state?.status);
const busy = state => ['preparing', 'recording', 'paused', 'saving'].includes(state?.status);
const broadcast = data => chrome.runtime.sendMessage({ target: 'panel', ...data }).catch(() => {});
const coordinate = task => {
  const result = stateQueue.catch(() => {}).then(task);
  stateQueue = result.catch(() => {});
  return result;
};
const autoExporter = new AutoExporter({ chrome, updateRecord: patchRecording,
  canPrepare: job => coordinate(async () => {
    if (job.format !== 'mp4') return true;
    await reconcileDesktop();
    const current = await chrome.storage.session.get(['recording', 'desktopRecording', 'captureSession']);
    if (busy(current.recording) || busy(current.desktopRecording) || current.captureSession) return false;
    await chrome.storage.session.set({ captureSession: { kind: 'conversion', sessionId: job.token, recordingId: job.recordingId } });
    return true;
  }),
  onRelease: job => coordinate(async () => {
    const { captureSession } = await chrome.storage.session.get('captureSession');
    if (captureSession?.kind === 'conversion' && captureSession.recordingId === job.recordingId && captureSession.sessionId === job.token) await releaseLock(captureSession.sessionId);
  }),
  onUpdate: async data => {
    if (data.export?.status === 'downloading') await coordinate(async () => {
      const { captureSession } = await chrome.storage.session.get('captureSession');
      if (captureSession?.kind === 'conversion' && captureSession.recordingId === data.recordingId) await releaseLock(captureSession.sessionId);
    });
    await exportAlarm();
    return broadcast({ type: 'EXPORT_STATE', ...data });
  } });
async function exportAlarm() {
  if (!chrome.alarms) return;
  const { autoExportJobs = [] } = await chrome.storage.session.get('autoExportJobs');
  if (currentExportJobs(autoExportJobs).some(activeExport)) await chrome.alarms.create('export-health', { periodInMinutes: 1 });
  else await chrome.alarms.clear('export-health');
}
const persistDiagnostics = (id, profile) => {
  if (!id || !profile?.samples?.length) return;
  patchRecording(id, { pageDiagnostics: { sessionId: profile.sessionId, samples: profile.samples } })
    .then(() => broadcast({ type: 'PERF_UPDATED', id })).catch(() => {});
};

async function baseline(tabId) {
  const setting = await chrome.storage.local?.get(['settings', 'setting_diagnostics']);
  if ((setting?.setting_diagnostics ?? setting?.settings?.diagnostics) !== true) return;
  let probe;
  await coordinate(async () => {
    const saved = await chrome.storage.session.get(['recording', 'desktopRecording', 'captureSession', 'pagePerfBaselines']);
    if (starting || busy(saved.recording) || busy(saved.desktopRecording) || saved.captureSession || Date.now() - (saved.recording?.finishedAt || 0) < 2500) return;
    const probes = saved.pagePerfBaselines || {};
    if (probes[tabId] && Date.now() - probes[tabId].at < 30000) return;
    probe = { sessionId: crypto.randomUUID(), tabId, at: Date.now(), samples: [] };
    const recent = Object.values(probes).filter(item => Date.now() - item.at < 30000).slice(-11);
    await chrome.storage.session.set({ pagePerfBaselines: Object.fromEntries([...recent, probe].map(item => [item.tabId, item])) });
  });
  if (probe) overlayMessage(tabId, 'PERF_BASELINE', { sessionId: probe.sessionId }).catch(() => {});
}

async function beginDiagnostics(tabId, sessionId, enabled) {
  if (!enabled) return;
  await coordinate(async () => {
    const { pagePerformance = {}, pagePerfBaselines = {} } = await chrome.storage.session.get(['pagePerformance', 'pagePerfBaselines']);
    const previous = pagePerfBaselines[tabId];
    const samples = previous && Date.now() - previous.at < 30000 ? previous.samples : [];
    const recent = Object.values(pagePerformance).slice(-3);
    const profile = { tabId, sessionId, samples, baselineSessionId: previous?.sessionId };
    await chrome.storage.session.set({ pagePerformance: Object.fromEntries([...recent, profile].map(item => [item.sessionId, item])) });
  });
}

async function receiveDiagnostic(message, sender) {
  const entry = diagnosticSample(message);
  if (!entry || !Number.isInteger(sender.tab?.id) || typeof message.sessionId !== 'string') return { ok: true, ignored: true };
  return coordinate(async () => {
    const { pagePerformance = {}, pagePerfBaselines = {} } = await chrome.storage.session.get(['pagePerformance', 'pagePerfBaselines']);
    const probe = pagePerfBaselines[sender.tab.id];
    if (message.phase === 'baseline' && probe?.sessionId === message.sessionId && Date.now() - probe.at < 30000) {
      pagePerfBaselines[sender.tab.id] = appendDiagnostic(probe, entry);
      for (const profile of Object.values(pagePerformance)) {
        if (profile.tabId === sender.tab.id && profile.baselineSessionId === probe.sessionId && !profile.finished) {
          pagePerformance[profile.sessionId] = appendDiagnostic(profile, entry);
        }
      }
      await chrome.storage.session.set({ pagePerfBaselines, pagePerformance }); return { ok: true };
    }
    const profile = pagePerformance[message.sessionId];
    if (!profile || profile.tabId !== sender.tab.id) return { ok: true, ignored: true };
    pagePerformance[message.sessionId] = appendDiagnostic(profile, entry);
    await chrome.storage.session.set({ pagePerformance });
    if (profile.finished) persistDiagnostics(profile.recordingId, pagePerformance[message.sessionId]);
    return { ok: true };
  });
}
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const sameCssViewport = (area, width, height) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 &&
  Math.abs(area.viewportWidth - width) <= 2 && Math.abs(area.viewportHeight - height) <= 2;
function cropInViewport(crop, width, height) {
  if (![crop?.x, crop?.y, crop?.width, crop?.height, crop?.viewportWidth, crop?.viewportHeight, width, height].every(Number.isFinite) ||
      crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.viewportWidth <= 0 || crop.viewportHeight <= 0 || width <= 0 || height <= 0) {
    throw new Error('框选范围无效，请重新框选后录制。');
  }
  const x = crop.x * crop.viewportWidth, y = crop.y * crop.viewportHeight;
  const w = crop.width * crop.viewportWidth, h = crop.height * crop.viewportHeight;
  if (x + w > width + 1e-6 || y + h > height + 1e-6) throw new Error('网页可见范围缩小，原框选区域已超出画面，请重新框选后录制。');
  return { ...crop, x: x / width, y: y / height, width: w / width, height: h / height, viewportWidth: width, viewportHeight: height };
}

async function releaseLock(sessionId) {
  const { captureSession } = await chrome.storage.session.get('captureSession');
  if (captureSession?.sessionId === sessionId) await chrome.storage.session.set({ captureSession: null });
}
const activeExport = job => ['queued', 'preparing', 'downloading'].includes(job.status) || job.cleanupPending;
// A failed session mirror must not keep a finished conversion looking active.
// The controller owns current state while this service worker remains alive.
const currentExportJobs = fallback => autoExporter.loaded ? autoExporter.jobs : fallback || [];
function extensionPage(sender, file) {
  try { const url = new URL(sender.url); return url.origin === new URL(chrome.runtime.getURL(file)).origin && url.pathname === `/${file}`; }
  catch { return false; }
}
async function desktopOwner(message, sender) {
  if (!extensionPage(sender, 'desktop.html')) throw new Error('无效的录制窗口');
  const id = sender.tab?.id ?? message.tabId ?? message.state?.ownerTabId;
  if (!Number.isInteger(id) || sender.tab && message.tabId !== undefined && message.tabId !== sender.tab.id) throw new Error('无效的录制窗口');
  const tab = await within(chrome.tabs.get(id), 2000, '录制窗口检查超时');
  if (tab.url !== chrome.runtime.getURL('desktop.html')) throw new Error('录制窗口已变化');
  if (sender.documentId) {
    const contexts = await within(chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [id],
      documentIds: [sender.documentId], documentUrls: [chrome.runtime.getURL('desktop.html')] }), 2000, '录制页面检查超时');
    if (!contexts.some(context => context.documentId === sender.documentId)) throw new Error('原录制页面已关闭或刷新，请在当前页面重试');
  } else if (typeof message.documentToken === 'string') {
    const status = await within(chrome.runtime.sendMessage({ target: 'desktop', type: 'STATUS', tabId: id }), 2000, '录制页面暂未响应');
    if (!status?.ok || status.documentToken !== message.documentToken) throw new Error('原录制页面已关闭或刷新，请在当前页面重试');
  }
  return { ownerTabId: id, ownerDocumentId: sender.documentId || null,
    ownerInstanceId: typeof message.documentToken === 'string' ? message.documentToken : null };
}
const ownsDesktop = (session, owner) => session?.ownerTabId === owner.ownerTabId &&
  (!session.ownerDocumentId || session.ownerDocumentId === owner.ownerDocumentId) &&
  (!session.ownerInstanceId || session.ownerInstanceId === owner.ownerInstanceId);

// Call under the state coordinator. A URL alone cannot distinguish a live
// recorder from a new document loaded in the same tab after a crash or refresh.
async function reconcileDesktop({ tabId, force = false, replacement, reason = '原桌面录制页面已关闭或刷新' } = {}) {
  const { captureSession, desktopRecording } = await chrome.storage.session.get(['captureSession', 'desktopRecording']);
  const owner = ['desktop', 'desktop-preview'].includes(captureSession?.kind) ? captureSession : busy(desktopRecording) ? desktopRecording : null;
  if (!owner || tabId !== undefined && owner.ownerTabId !== tabId) return;
  let gone = force;
  if (!gone && replacement && (owner.ownerDocumentId && replacement.ownerDocumentId || owner.ownerInstanceId && replacement.ownerInstanceId)) gone = !ownsDesktop(owner, replacement);
  if (!gone) {
    try {
      const tab = await within(chrome.tabs.get(owner.ownerTabId), 1500, '录制窗口检查超时');
      gone = tab.url !== chrome.runtime.getURL('desktop.html') || tab.discarded === true;
      if (!gone && owner.ownerDocumentId) {
        const contexts = await within(chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [owner.ownerTabId],
          documentIds: [owner.ownerDocumentId], documentUrls: [chrome.runtime.getURL('desktop.html')] }), 1500, '录制页面检查超时');
        gone = !contexts.some(context => context.documentId === owner.ownerDocumentId);
      }
      if (!gone) {
        const status = await within(chrome.runtime.sendMessage({ target: 'desktop', type: 'STATUS', tabId: owner.ownerTabId }), 1500, '录制页面暂未响应');
        if (status?.ok && typeof status.documentToken === 'string') {
          gone = !!status.closed || owner.ownerInstanceId && status.documentToken !== owner.ownerInstanceId ||
            status.sessionId !== owner.sessionId || status.state?.sessionId === owner.sessionId && terminal(status.state);
        }
      }
    } catch (error) {
      // A slow renderer is not proof that capture ended. Only an absent tab or
      // document, an explicit replacement, or a valid STATUS can release it.
      if (/No tab with id|tab (?:was )?closed|Invalid tab ID/i.test(error.message)) gone = true;
    }
  }
  if (!gone) return;
  let recovered;
  if (busy(desktopRecording) && desktopRecording.sessionId === owner.sessionId) {
    try {
      recovered = await within(recoverStoppedRecording(desktopRecording, { getRecording, patchRecording }, reason), 2500, '恢复桌面录制信息超时');
    } catch { recovered = { status: 'error', recoveryPending: true, error: `${reason}。可在录制库恢复已写入片段。` }; }
    recovered = { ...desktopRecording, ...recovered, released: true, aborted: true, finishedAt: Date.now(), sequence: (desktopRecording.sequence || 0) + 1 };
    delete recovered.autoExport;
    await chrome.storage.session.set({ desktopRecording: recovered });
  }
  await releaseLock(owner.sessionId);
  if (recovered) broadcast({ type: 'DESKTOP_RECOVERED', state: recovered });
  return recovered;
}
async function currentReaders() {
  const { mediaReaders = [] } = await chrome.storage.session.get('mediaReaders');
  return mediaReaders.filter(reader => reader.expiresAt > Date.now());
}
async function protectedRecordingIds() {
  await reconcileDesktop();
  const saved = await chrome.storage.session.get(['recording', 'desktopRecording', 'autoExportJobs', 'captureSession']);
  const ids = [busy(saved.recording) && saved.recording.id, busy(saved.desktopRecording) && saved.desktopRecording.id].filter(Boolean);
  return new Set([...ids, saved.captureSession?.kind === 'conversion' && saved.captureSession.recordingId,
    ...currentExportJobs(saved.autoExportJobs).filter(activeExport).map(job => job.recordingId),
    ...exportReservations, ...deletingRecordings, ...(await currentReaders()).map(reader => reader.recordingId)].filter(Boolean));
}
async function exportableRecording(recordingId) {
  if (deletingRecordings.has(recordingId)) throw new Error('这段录制正在删除，请稍后刷新录制库');
  await reconcileDesktop();
  const saved = await chrome.storage.session.get(['recording', 'desktopRecording']);
  if ([saved.recording, saved.desktopRecording].some(state => busy(state) && state.id === recordingId)) throw new Error('这段视频仍在录制或保存，请先结束录制');
  let record = await getRecording(recordingId);
  if (!record || !record.bytes) throw new Error('没有可导出的有效视频片段');
  if (!['complete', 'interrupted'].includes(record.status)) {
    await recoverStoppedRecording({ id: recordingId }, { getRecording, patchRecording }, '已恢复上次异常中断时落盘的片段');
    record = await getRecording(recordingId);
  }
  return record;
}
async function claimSession(kind, sessionId, ownerTabId, identity = {}) {
  if (closingRecorder) throw new Error('上一段录制正在清理，请稍后重试');
  await reconcileDesktop();
  const saved = await chrome.storage.session.get(['recording', 'desktopRecording', 'captureSession']);
  if (kind === 'desktop-preview' && saved.captureSession?.kind === kind && saved.captureSession.sessionId === sessionId && ownsDesktop(saved.captureSession, { ownerTabId, ...identity })) return;
  const { autoExportJobs = [] } = await chrome.storage.session.get('autoExportJobs');
  if (currentExportJobs(autoExportJobs).some(job => job.format === 'mp4' && job.status === 'preparing')) throw new Error('正在转换 MP4，请等待转换结束或先取消转换，再开始录制');
  if (kind === 'desktop' && saved.captureSession?.kind === 'desktop-preview' && saved.captureSession.sessionId === sessionId && ownsDesktop(saved.captureSession, { ownerTabId, ...identity })) saved.captureSession = null;
  if (saved.captureSession || busy(saved.recording) || busy(saved.desktopRecording)) throw new Error('已有录制正在进行，请先结束当前录制');
  await chrome.storage.session.set({ captureSession: { kind, sessionId, ownerTabId, ...identity } });
}

// All state writes, including recovery reads, share one coordinator. Network
// requests stay outside it so a pending preparation can always be cancelled.
async function acceptState(incoming) {
  const { recording: previous } = await chrome.storage.session.get('recording');
  if (incoming.sessionId && incoming.sessionId !== previous?.sessionId) return { ok: true, ignored: true };
  if (previous?.sessionId && incoming.sessionId !== previous.sessionId) return { ok: true, ignored: true };
  if (previous?.aborted && incoming.sessionId === previous.sessionId) return { ok: true, ignored: true };
  if (previous?.sessionId && (incoming.sequence || 0) <= (previous.sequence || 0)) return { ok: true, ignored: true };
  const state = { ...previous, ...incoming };
  delete state.autoExport;
  // CSS viewport confirmation belongs to this coordinator. The recorder's
  // initial preparing snapshot can arrive after the capture-ready handshake.
  for (const key of ['cropViewport', 'cropViewportPending']) {
    if (previous && Object.prototype.hasOwnProperty.call(previous, key)) state[key] = previous[key];
  }
  if (state.status === 'interrupted' && state.recoveryPending && state.id) {
    try {
      const recovered = await within(recoverStoppedRecording(state, { getRecording, patchRecording }, state.error || '上次保存异常中断'), 2500, '恢复保存信息超时');
      Object.assign(state, recovered, { recoveryPending: false });
    } catch { /* Retry/export will reconcile the persisted record once IDB responds. */ }
  }
  if (terminal(state)) state.finishedAt ||= Date.now();
  if (state.released || terminal(state)) { clearTimeout(stopWatchdog); stopWatchdog = null; }
  if ((state.released && !previous?.released || terminal(state)) && state.tabId) {
    try { await overlayMessage(state.tabId, 'END', { sessionId: state.sessionId, diagnostics: !!state.diagnostics }); }
    catch { state.restoreError = '录制已停止，但网页标注未能自动收起。请刷新网页恢复。'; }
  }
  await chrome.storage.session.set({ recording: state });
  if (terminal(state)) {
    if (state.diagnostics && state.id) {
      const { pagePerformance = {} } = await chrome.storage.session.get('pagePerformance');
      const profile = pagePerformance[state.sessionId];
      if (profile) {
        profile.finished = true; profile.recordingId = state.id;
        await chrome.storage.session.set({ pagePerformance });
        persistDiagnostics(state.id, profile);
      }
    }
    await releaseLock(state.sessionId);
    try {
      const contexts = await within(chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }), 2000, '检查录制进程超时');
      if (contexts.length) {
        closingRecorder = true;
        const closing = Promise.resolve().then(() => chrome.offscreen.closeDocument());
        closing.then(() => { closingRecorder = false; }, () => { closingRecorder = false; });
        await within(closing, 2000, '清理录制进程超时');
      }
    }
    catch { /* Released capture; document cleanup can be retried later. */ }
  }
  chrome.action.setBadgeText({ text: ['recording', 'paused'].includes(state.status) ? (state.status === 'paused' ? 'Ⅱ' : 'REC') : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e15f3b' });
  broadcast({ type: 'STATE', state });
  return { ok: true };
}

async function forceStop(sessionId, reason = '录制器未能正常结束，已强制停止采集') {
  return coordinate(async () => {
    const { recording } = await chrome.storage.session.get('recording');
    if (!busy(recording) || sessionId && recording.sessionId !== sessionId) return { ok: true, ignored: true };
    clearTimeout(stopWatchdog); stopWatchdog = null;
    try {
      const contexts = await within(chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }), 1500, '录制进程检查超时');
      if (contexts.length) {
        closingRecorder = true;
        const closing = Promise.resolve().then(() => chrome.offscreen.closeDocument());
        closing.then(() => { closingRecorder = false; }, () => { closingRecorder = false; });
        await within(closing, 2500, '录制进程未能关闭');
      }
    } catch {
      const state = { ...recording, stopFailed: true, error: '录制进程暂未响应。请在扩展管理页重新加载映录，以释放采集；已写入片段仍保留。' };
      await chrome.storage.session.set({ recording: state }); broadcast({ type: 'STATE', state });
      return { ok: false, error: state.error };
    }
    let recovered;
    try { recovered = await within(recoverStoppedRecording(recording, { getRecording, patchRecording }, reason), 2500, '恢复视频记录超时'); }
    catch { recovered = { status: 'error', error: `${reason}。可在录制库尝试恢复已写入片段。` }; }
    await acceptState({ ...recording, ...recovered, released: true, aborted: true,
      sequence: (recording.sequence || 0) + 1, forced: true });
    return { ok: true, forced: true };
  });
}

async function cancelPreparation(token, error) {
  if (!token || token.cancelled) return;
  token.cancelled = true;
  const problem = new Error(error || '已取消录制'); problem.name = error ? 'Error' : 'AbortError';
  token.reject(problem);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP', sessionId: token.sessionId }).catch(() => {});
  await coordinate(async () => {
    const { recording } = await chrome.storage.session.get('recording');
    if (recording?.sessionId !== token.sessionId || terminal(recording)) return;
    await acceptState({ ...recording, status: error ? 'error' : 'cancelled', error: error || null,
      sequence: (recording.sequence || 0) + 1, released: true, aborted: true, duration: 0 });
  });
}

chrome.action.onClicked.addListener(tab => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(error => broadcast({ type: 'ERROR', windowId: tab.windowId, error: error.message }));
  (async () => {
    const { recording } = await chrome.storage.session.get('recording');
    if (starting) return;
    if (!busy(recording)) {
      await connectTab(tab);
    } else if (recording.tabId === tab.id) await attach(tab.id);
    broadcast({ type: 'REFRESH', windowId: tab.windowId });
  })().catch(error => broadcast(error.code === 'HOST_ACCESS_REQUIRED'
    ? { type: 'REFRESH', windowId: tab.windowId, tabId: tab.id }
    : { type: 'ERROR', windowId: tab.windowId, tabId: tab.id, error: error.message, detail: error.detail, code: error.code }));
});

function attach(tabId) {
  // Several panel refreshes or commands can arrive together. Inject at most
  // once per tab, and release this entry on success and on every failure.
  if (attachments.has(tabId)) return attachments.get(tabId);
  const pending = attachPage(tabId).finally(() => {
    if (attachments.get(tabId) === pending) attachments.delete(tabId);
  });
  attachments.set(tabId, pending);
  return pending;
}
async function attachPage(tabId) {
  let tab;
  try { tab = await within(chrome.tabs.get(tabId), 2000, '获取网页超时'); }
  catch (error) { throw connectionError(error, 'tab'); }
  const unsupported = unsupportedPage(tab.url);
  if (unsupported) {
    const error = new Error(unsupported); error.connectionError = true; throw error;
  }
  try {
    const reply = await within(chrome.tabs.sendMessage(tabId, { target: 'overlay', type: 'PING' }, { frameId: 0 }), 1000, '网页连接检查超时');
    if (validateHandshake(reply)) return reply;
  } catch { /* A missing listener is expected before the first injection. */ }
  let results;
  try {
    results = await within(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] }), 5000, '网页标注加载超时');
  } catch (error) { throw connectionError(error, 'inject', tab.url); }
  const initialization = results?.find(result => result.frameId === 0)?.result;
  if (initialization?.ok === false) throw connectionError(new Error(initialization.error), 'initialize', tab.url);
  try {
    const reply = await within(chrome.tabs.sendMessage(tabId, { target: 'overlay', type: 'PING' }, { frameId: 0 }), 2000, '网页连接确认超时');
    if (!validateHandshake(reply)) throw new Error('标注脚本没有返回有效的连接确认');
    return reply;
  } catch (error) { throw connectionError(error, 'handshake', tab.url); }
}

async function connectTab(tab) {
  const attempt = ++connectionAttempt;
  const attemptId = crypto.randomUUID();
  automaticFailures.delete(tab.id);
  liveConnections.add(attemptId);
  let previousSelection;
  try {
    await coordinate(async () => {
      const { recording, selection } = await chrome.storage.session.get(['recording', 'selection']);
      if (starting || busy(recording)) throw new Error('请先结束当前录制，再切换录制网页');
      if (attempt !== connectionAttempt) return;
      previousSelection = selection;
      await chrome.storage.session.set({
        targetTab: { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url }, crop: null, selection: null, cropSelectionId: null,
        connection: { status: 'connecting', tabId: tab.id, attemptId, startedAt: Date.now() },
        ...(recording?.status === 'error' ? { recording: { ...recording, status: 'idle' } } : {})
      });
    });
    if (previousSelection) cancelPageSelection(previousSelection);
    if (attempt !== connectionAttempt) return;
    broadcast({ type: 'REFRESH', windowId: tab.windowId });
    const overlay = await attach(tab.id);
    await finishConnection({ status: 'connected', tabId: tab.id });
    baseline(tab.id).catch(() => {});
    return overlay;
  } catch (error) {
    await finishConnection({ status: error.code === 'HOST_ACCESS_REQUIRED' ? 'needs-activation' : 'error',
      tabId: tab.id, error: error.message, detail: error.detail, ...(error.code ? { code: error.code } : {}) });
    throw error;
  } finally { liveConnections.delete(attemptId); broadcast({ type: 'REFRESH', windowId: tab.windowId }); }
  function finishConnection(connection) {
    return coordinate(async () => {
      const saved = await chrome.storage.session.get(['connection', 'recording']);
      if (attempt !== connectionAttempt || saved.connection?.attemptId !== attemptId || busy(saved.recording)) return;
      await chrome.storage.session.set({ connection });
    });
  }
}
async function automaticAccess(tab) {
  if (!chrome.permissions?.contains) return { enabled: false, allowed: false };
  let enabled = false;
  try {
    enabled = await within(chrome.permissions.contains({ origins: autoConnectOrigins }), 1500, '读取网页权限超时');
    const page = new URL(tab?.url);
    const allowed = ['http:', 'https:'].includes(page.protocol) && (enabled
      || await within(chrome.permissions.contains({ origins: [`${page.origin}/*`] }), 1500, '读取网页权限超时'));
    return { enabled, allowed };
  } catch { return { enabled, allowed: false }; }
}
async function followPage(tab) {
  const old = automaticFailures.get(tab.id);
  if (old?.url === tab.url && old.connection) return { connection: old.connection };
  const entry = { url: tab.url };
  automaticFailures.set(tab.id, entry);
  if (automaticFailures.size > 32) automaticFailures.delete(automaticFailures.keys().next().value);
  try {
    const overlay = await attach(tab.id);
    if (automaticFailures.get(tab.id) === entry) automaticFailures.delete(tab.id);
    return { overlay };
  }
  catch (error) {
    const connection = { status: error.code === 'HOST_ACCESS_REQUIRED' ? 'needs-activation' : 'error',
      tabId: tab.id, error: error.message, detail: error.detail, ...(error.code ? { code: error.code } : {}) };
    // A navigation or explicit retry invalidates a late failure too.
    if (automaticFailures.get(tab.id) === entry) entry.connection = connection;
    return { connection };
  }
}

async function overlayMessage(tabId, type, options, timeoutMs = 2000) {
  try {
    const response = await within(chrome.tabs.sendMessage(tabId, { target: 'overlay', type, options }, { frameId: 0 }), timeoutMs, '网页暂未响应，请刷新网页恢复操作。');
    if (!response?.ok) throw new Error(response?.error || '网页没有确认操作，请刷新后重新连接。');
    return response;
  } catch (error) {
    throw connectionError(error, 'message');
  }
}
async function activeTab(windowId) {
  const [active] = await within(chrome.tabs.query(Number.isInteger(windowId) ? { active: true, windowId } : { active: true, currentWindow: true }), 2000, '识别当前网页超时，请重试连接。');
  return active;
}
async function requireCurrentTab(tabId, windowId) {
  const active = await activeTab(windowId);
  if (active?.id !== tabId) throw new Error('网页已切换，已取消这次操作。请在当前网页重新开始录制。');
  return active;
}
function cancelPageSelection(selection) {
  overlayMessage(selection.tabId, 'CANCEL_CROP', { selectionId: selection.id }).catch(() => {});
  broadcast({ type: 'CROP_CANCEL', selectionId: selection.id, tabId: selection.tabId, windowId: selection.windowId });
}
async function offscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'BLOBS'], justification: '在后台录制网页并分段保存到本机录制库' }).finally(() => { creating = null; });
  await creating;
}
async function route(message, sender) {
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')) && !['CROP', 'CROP_CANCEL', 'TOOL_CHANGED', 'VIEWPORT_RESIZE', 'PERF_SAMPLE', 'ANNOTATION_ERROR'].includes(message.type)) throw new Error('不支持的网页消息');
  if (message.type === 'PERF_SAMPLE') return receiveDiagnostic(message, sender);
  if (message.type === 'EXPORT_READY') return autoExporter.handleReady(message, sender);
  if (message.type === 'EXPORT_ERROR') return autoExporter.handleError(message, sender);
  if (message.type === 'EXPORT_PROGRESS') return autoExporter.handleProgress(message, sender);
  if (message.type === 'EXPORT_CANCEL') return autoExporter.cancel(message.recordingId);
  if (message.type === 'GET_EXPORT_STATE') {
    const record = await getRecording(message.recordingId);
    if (!record) throw new Error('录制不存在或已被删除');
    await autoExporter.recover(message.recordingId, record.export);
    return autoExporter.getState(message.recordingId);
  }
  if (message.type === 'RETRY_EXPORT') {
    const record = await coordinate(() => within(exportableRecording(message.recordingId), 3000, '读取录制信息超时，请稍后重试'));
    const format = message.format || 'original';
    if (!['original', 'mp4'].includes(format)) throw new Error('不支持的导出格式');
    if (format === 'mp4') {
      const current = await chrome.storage.session.get(['recording', 'desktopRecording', 'captureSession']);
      if (busy(current.recording) || busy(current.desktopRecording) || current.captureSession) throw new Error('请先结束录制和来源预览，再转换 MP4');
    }
    exportReservations.add(record.id);
    try { return await autoExporter.retry(record.id, { format }); }
    finally { exportReservations.delete(record.id); }
  }
  if (['MEDIA_READ_ACQUIRE', 'MEDIA_READ_RENEW', 'MEDIA_READ_RELEASE', 'DELETE_RECORDING'].includes(message.type)) {
    if (!extensionPage(sender, 'library.html')) throw new Error('无效的录制库操作');
    return coordinate(async () => {
      if (typeof message.recordingId !== 'string' || !message.recordingId) throw new Error('无效的录制编号');
      let readers = await currentReaders();
      if (message.type === 'DELETE_RECORDING') {
        if ((await protectedRecordingIds()).has(message.recordingId)) throw new Error('这段视频正在录制、读取或导出，请完成后再删除');
        deletingRecordings.add(message.recordingId);
        const deleting = deleteRecording(message.recordingId).finally(() => deletingRecordings.delete(message.recordingId));
        await within(deleting, 3000, '删除暂未完成，请稍后刷新。该视频暂时保持占用保护'); return { ok: true };
      }
      if (typeof message.token !== 'string' || message.token.length < 8 || message.token.length > 200) throw new Error('无效的读取凭据');
      const owner = sender.documentId || `${sender.tab?.id ?? message.tabId ?? ''}:${sender.url}`;
      const match = reader => reader.token === message.token && reader.recordingId === message.recordingId && reader.owner === owner;
      if (message.type === 'MEDIA_READ_RELEASE') readers = readers.filter(reader => !match(reader));
      else if (message.type === 'MEDIA_READ_RENEW') {
        const reader = readers.find(match);
        if (!reader) throw new Error('视频读取占用已失效，请重新导出');
        reader.expiresAt = Date.now() + 600000;
      } else {
        await within(exportableRecording(message.recordingId), 3000, '读取录制信息超时，请稍后重试');
        if (!readers.some(match)) readers.push({ recordingId: message.recordingId, token: message.token, owner,
          tabId: sender.tab?.id ?? message.tabId, expiresAt: Date.now() + 600000 });
      }
      await chrome.storage.session.set({ mediaReaders: readers }); return { ok: true };
    });
  }
  if (message.windowId !== undefined && (!Number.isInteger(message.windowId) || message.windowId < 0)) throw new Error('没有识别到侧栏所在窗口，请重新打开映录。');
  const windowId = message.windowId;
  const saved = await chrome.storage.session.get(['recording', 'targetTab', 'crop', 'connection', 'selection']);
  // The last toolbar click is only a legacy fallback. Side panels explicitly
  // identify their displayed tab and window; a different window cannot rebind it.
  const requestedTab = sender.url?.startsWith(chrome.runtime.getURL('')) ? message.tabId : sender.tab?.id;
  const tabId = busy(saved.recording) ? saved.recording.tabId : requestedTab ?? saved.targetTab?.id;
  if (message.type === 'GET_STATE') {
    let warning;
    if (busy(saved.recording) && !saved.recording.released && saved.recording.stopRequestedAt && Date.now() - saved.recording.stopRequestedAt > 6000) {
      await forceStop(saved.recording.sessionId);
      Object.assign(saved, await chrome.storage.session.get('recording'));
    }
    if (busy(saved.recording) && !starting && !closingRecorder) {
      let actual;
      try { actual = await within(chrome.runtime.sendMessage({ target: 'offscreen', type: 'STATUS' }), 3000, '录制状态查询超时'); } catch { /* Recorder context is gone or unresponsive. */ }
      await coordinate(async () => {
        const { recording: latest } = await chrome.storage.session.get('recording');
        if (!busy(latest) || latest.sessionId !== saved.recording.sessionId || latest.sequence !== saved.recording.sequence) return;
        if (actual?.state && actual.state.sessionId === latest.sessionId && actual.state.status !== 'idle') {
          await acceptState(actual.state);
        } else {
          let contexts;
          try { contexts = await within(chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }), 2000, '录制进程检查超时'); } catch { /* Unknown is not proof of termination. */ }
          if (contexts === undefined || contexts.length && actual?.state?.status !== 'idle') {
            warning = '录制进程暂未响应，已保留当前状态。请稍后重试结束录制。'; return;
          }
          const reason = '录制进程已断开';
          let recovered;
          try { recovered = await within(recoverStoppedRecording(latest, { getRecording, patchRecording }, reason), 2500, '恢复视频记录超时'); }
          catch { recovered = { status: 'error', error: `${reason}。可在录制库尝试恢复已保存片段，然后重新开始。` }; }
          await acceptState({ ...latest, ...recovered, sequence: (latest.sequence || 0) + 1, released: true, aborted: true });
        }
      });
    }
    Object.assign(saved, await chrome.storage.session.get(['recording', 'targetTab', 'crop', 'connection', 'selection']));
    let displayTab = saved.targetTab, displayId = tabId, isCurrentTab = true;
    if (Number.isInteger(windowId)) {
      const current = await activeTab(windowId);
      if (busy(saved.recording)) {
        displayTab = saved.recording.sourceTab;
        if (!displayTab) try { displayTab = await chrome.tabs.get(saved.recording.tabId); } catch { /* Closed source is being finalized. */ }
        displayTab ||= { id: saved.recording.tabId, title: '正在录制的网页' };
      } else displayTab = current;
      displayId = displayTab?.id;
      isCurrentTab = !!current && displayId === current.id;
      saved.targetTab = displayTab;
      if (saved.recording?.status === 'error' && saved.recording.tabId !== displayId) saved.recording = { status: 'idle' };
      if (saved.connection?.tabId !== displayId) saved.connection = { status: 'needs-activation', tabId: displayId };
      if (saved.selection?.tabId !== displayId) saved.crop = null;
    }
    let overlay;
    if (displayId && isCurrentTab) try { overlay = await within(chrome.tabs.sendMessage(displayId, { target: 'overlay', type: 'PING' }, { frameId: 0 }), 2000, '网页暂未响应'); } catch { /* Page may have navigated or be busy. */ }
    const unsupported = unsupportedPage(displayTab?.url);
    const pageLoading = !!displayId && displayTab?.status === 'loading'
      && (!displayTab.url || displayTab.url === 'about:blank');
    const access = await automaticAccess(displayTab);
    // Only a visible side panel follows its own window. Tab events merely ask
    // that panel to refresh; opening other websites alone never injects code.
    if (!validateHandshake(overlay) && isCurrentTab && displayId && !unsupported && !pageLoading
      && !starting && !busy(saved.recording) && Number.isInteger(windowId)
      && extensionPage(sender, 'panel.html') && access.allowed) {
      const followed = await followPage(displayTab);
      overlay = followed.overlay;
      if (followed.connection) saved.connection = followed.connection;
    }
    const connected = isCurrentTab && validateHandshake(overlay);
    if (saved.connection?.status === 'connecting' && connected && !liveConnections.has(saved.connection.attemptId)) {
      const previous = saved.connection;
      await coordinate(async () => {
        const current = await chrome.storage.session.get('connection');
        if (current.connection?.status === 'connecting' && current.connection.attemptId === previous.attemptId)
          await chrome.storage.session.set({ connection: { status: 'connected', tabId: displayId } });
      });
    }
    if (connected) saved.connection = { status: 'connected', tabId: displayId };
    else if (saved.connection?.status === 'connecting' && (!liveConnections.has(saved.connection.attemptId)
      || Date.now() - (saved.connection.startedAt || 0) > 12000)) {
      const previous = saved.connection;
      saved.connection = { status: 'error', tabId: displayId, error: '上次网页连接已中断，请重试连接。' };
      await coordinate(async () => {
        const current = await chrome.storage.session.get('connection');
        if (current.connection?.status === 'connecting' && current.connection.attemptId === previous.attemptId)
          await chrome.storage.session.set({ connection: saved.connection });
      });
    }
    if (pageLoading && isCurrentTab && !connected) saved.connection = { status: 'loading', tabId: displayId };
    else if (unsupported && isCurrentTab) saved.connection = { status: 'error', tabId: displayId, error: unsupported };
    if (connected && !busy(saved.recording)) baseline(displayId).catch(() => {});
    return { ok: true, ...saved, warning, overlay, connected, isCurrentTab, pageLoading,
      autoConnectEnabled: access.enabled,
      needsActivation: isCurrentTab && !connected && !unsupported && !pageLoading && !!displayId
        && !displayTab?.url?.startsWith('file:') && (!access.allowed || saved.connection?.code === 'HOST_ACCESS_REQUIRED'),
      version: chrome.runtime.getManifest().version };
  }
  if (message.type === 'CONNECT') {
    if (starting || busy(saved.recording)) throw new Error('请先结束当前录制，再切换录制网页');
    const tab = await activeTab(windowId);
    if (!tab?.id) throw new Error('没有找到当前网页，请回到 Chrome 中的项目网页再试。');
    const overlay = await connectTab(tab);
    return { ok: true, overlay };
  }
  if (message.type === 'MUSIC') {
    if (!extensionPage(sender, 'panel.html')) throw new Error('无效的音乐控制');
    const { recording } = await chrome.storage.session.get('recording');
    if (!message.sessionId || recording?.sessionId !== message.sessionId || !['recording', 'paused'].includes(recording.status)) return { ok: true, ignored: true };
    if (!['play', 'pause', 'restart', 'volume', 'loop'].includes(message.command)) throw new Error('不支持的音乐操作');
    return within(chrome.runtime.sendMessage({ target: 'offscreen', type: 'MUSIC', sessionId: message.sessionId,
      command: message.command, value: message.value }), 4000, '音乐控制暂未响应，视频录制仍在继续。');
  }
  if (message.type === 'STATE') {
    return coordinate(() => acceptState(message.state));
  }
  if (message.type === 'DESKTOP_READY') {
    return coordinate(async () => {
      const owner = await desktopOwner(message, sender);
      return { ok: true, recovered: await reconcileDesktop({ tabId: owner.ownerTabId, replacement: owner }) };
    });
  }
  if (message.type === 'DESKTOP_ACQUIRE') {
    if (!message.sessionId) throw new Error('无效的录制窗口');
    return coordinate(async () => {
      const owner = await desktopOwner(message, sender);
      await claimSession('desktop', message.sessionId, owner.ownerTabId, owner); return { ok: true };
    });
  }
  if (message.type === 'DESKTOP_PREVIEW_ACQUIRE' || message.type === 'DESKTOP_PREVIEW_RELEASE') {
    if (!message.sessionId) throw new Error('无效的来源预览窗口');
    return coordinate(async () => {
      const owner = await desktopOwner(message, sender);
      if (message.type === 'DESKTOP_PREVIEW_ACQUIRE') await claimSession('desktop-preview', message.sessionId, owner.ownerTabId, owner);
      else {
        const { captureSession } = await chrome.storage.session.get('captureSession');
        if (captureSession?.kind === 'desktop-preview' && ownsDesktop(captureSession, owner)) await releaseLock(message.sessionId);
      }
      return { ok: true };
    });
  }
  if (message.type === 'DESKTOP_STATE' || message.type === 'DESKTOP_RELEASE') {
    return coordinate(async () => {
      const owner = await desktopOwner(message, sender);
      const { captureSession, desktopRecording } = await chrome.storage.session.get(['captureSession', 'desktopRecording']);
      const sessionId = message.state?.sessionId || message.sessionId;
      if (captureSession?.kind !== 'desktop' || captureSession.sessionId !== sessionId || !ownsDesktop(captureSession, owner)) return { ok: true, ignored: true };
      if (message.type === 'DESKTOP_RELEASE') {
        await reconcileDesktop({ tabId: owner.ownerTabId, force: true, reason: '桌面录制页面已结束采集' });
      } else {
        if (desktopRecording?.sessionId === sessionId && (message.state.sequence || 0) <= (desktopRecording.sequence || 0)) return { ok: true, ignored: true };
        const state = { ...message.state, ...owner };
        delete state.autoExport;
        await chrome.storage.session.set({ desktopRecording: state });
        if (terminal(state)) await releaseLock(sessionId);
      }
      return { ok: true };
    });
  }
  if (message.type === 'GET_ACTIVE_RECORDINGS') {
    return coordinate(async () => {
      await reconcileDesktop();
      const current = await chrome.storage.session.get(['recording', 'desktopRecording', 'autoExportJobs', 'captureSession']);
      const ids = []; let webActive = false, desktopActive = false;
      if (busy(current.recording) && (starting || (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)) { webActive = true; ids.push(current.recording.id); }
      if (busy(current.desktopRecording)) {
        try {
          const owner = await chrome.tabs.get(current.desktopRecording.ownerTabId);
          if (!owner.url || owner.url === chrome.runtime.getURL('desktop.html')) { desktopActive = true; ids.push(current.desktopRecording.id); }
        } catch { /* Closed recorder is recoverable, not active. */ }
      }
      const exportIds = [...currentExportJobs(current.autoExportJobs).filter(activeExport).map(job => job.recordingId),
        ...(current.captureSession?.kind === 'conversion' && current.captureSession.recordingId ? [current.captureSession.recordingId] : []),
        ...exportReservations, ...(await currentReaders()).map(reader => reader.recordingId)];
      return { ok: true, ids: ids.filter(Boolean), exportIds, mediaActivity: {
        web: webActive, desktop: desktopActive, reserved: !!current.captureSession
      } };
    });
  }
  if (message.type === 'TOOL_CHANGED') {
    if (sender.tab?.id !== tabId) return { ok: false };
    broadcast({ type: 'TOOL_CHANGED', options: message.options, tabId }); return { ok: true };
  }
  if (message.type === 'ANNOTATION_ERROR') {
    if (!Number.isInteger(sender.tab?.id) || sender.tab.id !== tabId || sender.frameId !== undefined && sender.frameId !== 0 ||
      typeof message.error !== 'string' || !message.error || message.error.length > 300) return { ok: false };
    broadcast({ type: 'ANNOTATION_ERROR', error: message.error, tabId, windowId: sender.tab.windowId });
    return { ok: true };
  }
  if (message.type === 'VIEWPORT_RESIZE') {
    const recording = saved.recording;
    if (sender.tab?.id !== recording?.tabId || sender.frameId !== undefined && sender.frameId !== 0 || !busy(recording) || !recording.cropViewport || recording.cropViewportPending || message.sessionId !== recording.sessionId ||
        !Number.isFinite(message.width) || !Number.isFinite(message.height) || message.width <= 0 || message.height <= 0 ||
        sameCssViewport(recording.cropViewport, message.width, message.height)) return { ok: true, ignored: true };
    const error = recording.status === 'preparing' ? '网页尺寸在准备期间发生变化，尚未开始录制，请重新框选。'
      : '网页尺寸发生变化，已停止并保存现有片段。请重新框选后开始录制。';
    if (recording.status === 'preparing' && startAttempt?.sessionId === recording.sessionId) await cancelPreparation(startAttempt, error);
    else await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP', sessionId: recording.sessionId, error });
    return { ok: true };
  }
  if (message.type === 'CAPTURE_VIEWPORT_READY') {
    if (!extensionPage(sender, 'offscreen.html')) throw new Error('无效的录制来源');
    const token = startAttempt;
    const assertPreparing = recording => {
      if (!token || token.cancelled || token.sessionId !== message.sessionId || startAttempt !== token ||
          recording?.sessionId !== token.sessionId || recording.status !== 'preparing') throw new Error('框选录制准备已结束，请重新开始。');
    };
    assertPreparing(saved.recording);
    if (!token.crop) return { ok: true, crop: null, cropViewport: null };
    const viewport = await overlayMessage(saved.recording.tabId, 'CAPTURE_VIEWPORT', { sessionId: token.sessionId }, 3500);
    const crop = cropInViewport(token.crop, viewport.width, viewport.height);
    const cropViewport = { viewportWidth: viewport.width, viewportHeight: viewport.height };
    await coordinate(async () => {
      const { recording } = await chrome.storage.session.get('recording'); assertPreparing(recording);
      await chrome.storage.session.set({ recording: { ...recording, cropViewport, cropViewportPending: false } });
    });
    await overlayMessage(saved.recording.tabId, 'ARM_VIEWPORT', { sessionId: token.sessionId, crop: cropViewport });
    assertPreparing((await chrome.storage.session.get('recording')).recording);
    return { ok: true, crop, cropViewport };
  }
  if (message.type === 'CROP' || message.type === 'CROP_CANCEL') {
    return coordinate(async () => {
      const current = await chrome.storage.session.get(['selection', 'recording']);
      if (sender.tab?.id !== tabId || busy(current.recording) || !message.selectionId || current.selection?.id !== message.selectionId || current.selection.tabId !== sender.tab.id) return { ok: true, ignored: true };
      if (message.type === 'CROP') await chrome.storage.session.set({ crop: message.crop, cropSelectionId: message.selectionId });
      else await chrome.storage.session.set({ selection: null, crop: null, cropSelectionId: null });
      broadcast({ type: message.type === 'CROP' ? 'CROP_READY' : 'CROP_CANCEL', crop: message.crop, selectionId: message.selectionId, tabId, windowId: current.selection.windowId });
      return { ok: true };
    });
  }
  if (message.type === 'RESET_CROP') {
    if (busy(saved.recording)) throw new Error('请先结束当前录制');
    await chrome.storage.session.set({ crop: null });
    return { ok: true };
  }
  if (message.type === 'OVERLAY') {
    const commandTabId = requestedTab ?? tabId;
    if (!commandTabId) throw new Error('请先在项目网页上点击扩展图标');
    if (busy(saved.recording) && commandTabId !== saved.recording.tabId && message.command !== 'CANCEL_CROP') throw new Error('录制来源已变化，请切回正在录制的网页后操作。');
    if (message.command === 'CROP' && busy(saved.recording)) throw new Error('录制开始后不能修改范围');
    if (message.command !== 'CANCEL_CROP') await requireCurrentTab(commandTabId, windowId);
    if (message.command === 'CROP') {
      if (!message.options?.selectionId) throw new Error('框选请求已失效，请重新选择');
      let previousSelection;
      await coordinate(async () => {
        const current = await chrome.storage.session.get(['recording', 'selection']);
        if (busy(current.recording) || starting) throw new Error('录制开始后不能修改范围');
        previousSelection = current.selection;
        await chrome.storage.session.set({ selection: { id: message.options.selectionId, tabId: commandTabId, windowId }, crop: null, cropSelectionId: null });
      });
      if (previousSelection && previousSelection.id !== message.options.selectionId) cancelPageSelection(previousSelection);
    }
    if (message.command === 'CANCEL_CROP') await coordinate(async () => {
      const { selection } = await chrome.storage.session.get('selection');
      if (selection?.tabId === commandTabId && (!message.options?.selectionId || selection.id === message.options.selectionId)) await chrome.storage.session.set({ selection: null, crop: null, cropSelectionId: null });
    });
    await attach(commandTabId);
    if (message.command === 'CROP') {
      const { selection, recording } = await chrome.storage.session.get(['selection', 'recording']);
      if (selection?.id !== message.options.selectionId || busy(recording)) return { ok: true, ignored: true };
    }
    return await overlayMessage(commandTabId, message.command, message.options);
  }
  if (message.type === 'START') {
    if (!tabId) throw new Error('请先在项目网页上点击扩展图标');
    const options = { ...message.options };
    options.music = musicConfig(options.music);
    delete options.autoExport;
    const sessionId = crypto.randomUUID();
    let reject;
    const aborted = new Promise((_, fail) => { reject = fail; });
    const token = { sessionId, reject, cancelled: false, tabId, range: options.range };
    await coordinate(async () => {
      if (starting) throw new Error('已有录制正在进行');
      await claimSession('web', sessionId, tabId);
      starting = true;
      startAttempt = token;
      await chrome.storage.session.set({ recording: { status: 'preparing', tabId, sessionId, sequence: 0,
        diagnostics: options.diagnostics === true } });
    });
    const assertCurrent = () => { if (token.cancelled) { const error = new Error('已取消录制'); error.name = 'AbortError'; throw error; } };
    const timer = setTimeout(() => { cancelPreparation(token, '连接录制超时，已释放采集，请重试。').catch(() => {}); }, 25000);
    const prepare = async () => {
      assertCurrent();
      const sourceTab = await requireCurrentTab(tabId, windowId); assertCurrent();
      await attach(tabId); assertCurrent();
      const latest = await chrome.storage.session.get(['crop', 'cropSelectionId', 'selection']); assertCurrent();
      const crop = options.range === 'region' ? latest.crop : null;
      if (options.range === 'region' && (!crop || !message.selectionId || latest.cropSelectionId !== message.selectionId || latest.selection && latest.selection.tabId !== tabId)) throw new Error('请先拖动选择录制范围');
      if (crop) cropInViewport(crop, crop.viewportWidth, crop.viewportHeight);
      token.crop = crop;
      const cropViewport = crop ? { viewportWidth: crop.viewportWidth, viewportHeight: crop.viewportHeight } : null;
      await coordinate(async () => {
        assertCurrent();
        const { recording } = await chrome.storage.session.get('recording');
        if (recording?.sessionId === sessionId) await chrome.storage.session.set({ recording: { ...recording, cropViewport, cropViewportPending: !!crop, sourceTab, clicks: !!options.clicks } });
      });
      await beginDiagnostics(tabId, sessionId, options.diagnostics === true); assertCurrent();
      await overlayMessage(tabId, 'BEGIN', { clicks: options.clicks, crop: cropViewport, deferViewport: !!crop, sessionId, diagnostics: options.diagnostics === true }); assertCurrent();
      await offscreen(); assertCurrent();
      let streamId;
      try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
      catch (error) { throw /not been invoked|activeTab/i.test(error.message) ? connectionError(error, 'capture') : error; }
      assertCurrent();
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'START', streamId,
        options: { ...options, crop, title: sourceTab?.title || '网页演示', context: { tabId, sessionId, sourceTab, cropViewport, cropViewportPending: !!crop, clicks: !!options.clicks,
          diagnostics: options.diagnostics === true } } });
      assertCurrent();
      if (!response?.ok) {
        const problem = new Error(response?.error || '录制启动失败');
        problem.detail = response?.detail;
        if (response?.cancelled) problem.name = 'AbortError';
        throw problem;
      }
      return response;
    };
    try {
      return await Promise.race([prepare(), aborted]);
    } catch (error) {
      await coordinate(async () => {
        const { recording } = await chrome.storage.session.get('recording');
        if (recording?.sessionId !== sessionId || terminal(recording)) return;
        await acceptState({ ...recording, status: error.name === 'AbortError' ? 'cancelled' : 'error',
          error: error.name === 'AbortError' ? null : error.message, detail: error.detail, sequence: (recording.sequence || 0) + 1, released: true, aborted: true });
      });
      if (error.name === 'AbortError') return { ok: true, cancelled: true };
      throw error;
    } finally { clearTimeout(timer); if (startAttempt === token) { starting = false; startAttempt = null; } }
  }
  if (['PAUSE', 'RESUME', 'STOP', 'FORCE_STOP'].includes(message.type)) {
    const current = await coordinate(() => chrome.storage.session.get('recording'));
    if (message.sessionId && message.sessionId !== current.recording?.sessionId) return { ok: true, ignored: true };
    if (['STOP', 'FORCE_STOP'].includes(message.type) && startAttempt?.sessionId === current.recording?.sessionId && current.recording?.status === 'preparing') {
      await cancelPreparation(startAttempt); return { ok: true, cancelled: true };
    }
    if (!busy(current.recording)) return { ok: true, ignored: true };
    if (message.type === 'FORCE_STOP' || message.type === 'STOP' && current.recording.status === 'saving') return forceStop(current.recording.sessionId);
    if (message.type === 'STOP') {
      const requested = await coordinate(async () => {
        const { recording } = await chrome.storage.session.get('recording');
        if (recording?.sessionId !== current.recording.sessionId || !busy(recording)) return false;
        await chrome.storage.session.set({ recording: { ...recording, stopRequestedAt: Date.now() } });
        clearTimeout(stopWatchdog);
        stopWatchdog = setTimeout(() => { forceStop(current.recording.sessionId).catch(() => {}); }, 6000);
        stopWatchdog?.unref?.();
        return true;
      });
      if (!requested) return { ok: true, ignored: true };
    }
    try { return await within(chrome.runtime.sendMessage({ target: 'offscreen', type: message.type, sessionId: current.recording?.sessionId }), 3000, '录制控制暂未响应，请稍后重试。'); }
    catch (error) { if (message.type === 'STOP') return forceStop(current.recording.sessionId); throw error; }
  }
  throw new Error('未知操作');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const result = route(message, sender);
  result.then(reply).catch(error => reply({ ok: false, error: error.message, detail: error.detail, ...(error.code ? { code: error.code } : {}) }));
  return true;
});
chrome.tabs.onActivated?.addListener(info => {
  // A new activation is a new chance after a transient load/handshake failure.
  // Ordinary GET_STATE requests still reuse the cached failure, without polling.
  automaticFailures.delete(info.tabId);
  attachments.delete(info.tabId);
  broadcast({ type: 'REFRESH', windowId: info.windowId, tabId: info.tabId, reason: 'tab-activated' });
  coordinate(async () => {
    const { recording, selection } = await chrome.storage.session.get(['recording', 'selection']);
    if (busy(recording) || !selection || selection.windowId !== info.windowId || selection.tabId === info.tabId) return;
    await chrome.storage.session.set({ selection: null, crop: null, cropSelectionId: null });
    cancelPageSelection(selection);
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (id, change, tab) => {
  autoExporter.tabUpdated(id, change, tab).catch(() => {});
  if (change.status === 'complete') {
    automaticFailures.delete(id);
    // A pending operation can still belong to a loading/removed document. Its
    // late failure must not be reused by the newly ready document.
    attachments.delete(id);
  }
  // The activation event can precede the URL. Notify as soon as a visible page
  // has new metadata, rather than waiting for every subresource to finish.
  if (tab?.active && (change.url || change.status || change.discarded !== undefined))
    broadcast({ type: 'REFRESH', windowId: tab.windowId, tabId: id, reason: 'tab-updated' });
  else if (tab?.active && change.title !== undefined)
    broadcast({ type: 'PAGE_TITLE', windowId: tab.windowId, tabId: id, title: tab.title });
  if (change.status === 'loading' || change.url) {
    const token = startAttempt;
    if (token?.tabId === id && token.range === 'region' && !token.cancelled) {
      const { recording } = await chrome.storage.session.get('recording');
      if (recording?.sessionId === token.sessionId && recording.status === 'preparing') {
        // Cancellation enters the coordinator itself. Do not await it while
        // holding the coordinator, and never carry a selection into a new page.
        await cancelPreparation(token, '准备录制时网页已跳转或刷新，尚未开始录制，请重新框选。');
      }
    }
  }
  if (change.status === 'loading' || change.url || change.discarded) {
    automaticFailures.delete(id);
    attachments.delete(id); // A previous document's late handshake cannot be reused.
    await coordinate(async () => {
      const { pagePerfBaselines = {}, mediaReaders = [], captureSession, desktopRecording } = await chrome.storage.session.get(['pagePerfBaselines', 'mediaReaders', 'captureSession', 'desktopRecording']);
      if (pagePerfBaselines[id]) { delete pagePerfBaselines[id]; await chrome.storage.session.set({ pagePerfBaselines }); }
      if (mediaReaders.some(reader => reader.tabId === id || reader.expiresAt <= Date.now()))
        await chrome.storage.session.set({ mediaReaders: mediaReaders.filter(reader => reader.tabId !== id && reader.expiresAt > Date.now()) });
      if (captureSession?.ownerTabId === id && ['desktop', 'desktop-preview'].includes(captureSession.kind)
        || busy(desktopRecording) && desktopRecording.ownerTabId === id) await reconcileDesktop({ tabId: id });
    });
  }
  if (change.status !== 'complete') return;
  const { recording } = await chrome.storage.session.get('recording');
  if (!busy(recording) || recording.tabId !== id) return;
  attach(id).then(viewport => coordinate(async () => {
    const { recording: current } = await chrome.storage.session.get('recording');
    if (current?.sessionId !== recording.sessionId || !['preparing', 'recording', 'paused'].includes(current?.status)) return;
    if (current.cropViewport && !current.cropViewportPending && !sameCssViewport(current.cropViewport, viewport.width, viewport.height)) {
      const error = current.status === 'preparing' ? '网页尺寸在准备期间发生变化，尚未开始录制，请重新框选。'
        : '网页尺寸发生变化，已停止并保存现有片段。请重新框选后开始录制。';
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP', sessionId: current.sessionId, error }).catch(() => {}); return;
    }
    return overlayMessage(id, 'BEGIN', { clicks: !!current.clicks, crop: current.cropViewport, deferViewport: !!current.cropViewportPending, sessionId: current.sessionId, diagnostics: !!current.diagnostics });
  })).catch(() => broadcast({ type: 'ERROR', error: '页面已跳转，视频仍在录制。若标注不可用，请在新页面再次点击扩展图标。' }));
});
chrome.tabs.onRemoved?.addListener(id => {
  automaticFailures.delete(id);
  attachments.delete(id);
  autoExporter.tabRemoved(id).catch(() => {});
  coordinate(async () => {
    await reconcileDesktop({ tabId: id, force: true, reason: '桌面录制窗口已关闭' });
    const { mediaReaders = [] } = await chrome.storage.session.get('mediaReaders');
    if (mediaReaders.some(reader => reader.tabId === id || reader.expiresAt <= Date.now()))
      await chrome.storage.session.set({ mediaReaders: mediaReaders.filter(reader => reader.tabId !== id && reader.expiresAt > Date.now()) });
  }).catch(() => {});
});
chrome.permissions?.onAdded?.addListener(() => { automaticFailures.clear(); broadcast({ type: 'REFRESH' }); });
chrome.permissions?.onRemoved?.addListener(() => { automaticFailures.clear(); broadcast({ type: 'REFRESH' }); });
chrome.downloads?.onChanged?.addListener(delta => { autoExporter.changed(delta).catch(() => {}); });
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === 'export-health') autoExporter.checkStalled().then(exportAlarm).catch(() => {});
});
autoExporter.restore().then(exportAlarm).catch(() => {});
