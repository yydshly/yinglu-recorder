import { createFileResource } from './lib/file-resource.js';
import { bounded } from './lib/async.js';
import { listRecordingPage, getRecording, writeRecordingTo, deleteRecording } from './lib/db.js';
import { prepareRecordingPreview, cleanupPreviewFiles, PREVIEW_BLOB_LIMIT } from './lib/preview.js';
import { clockText, fileSize } from './lib/geometry.js';
import { extensionForMime, isRecordingFormatSupported } from './lib/media-format.js';
const $ = id => document.getElementById(id);
let url, diagnosticsUrl, exporting = false, retryingExport = false, currentRecord = null, exportRevision = 0, diagnosticsRevision = 0;
const extension = !!globalThis.chrome?.runtime?.id;
const exportLabels = { queued: '等待导出', preparing: '正在准备导出', converting: '正在转换视频', downloading: '正在下载到本机', complete: '导出完成', error: '导出失败', cancelled: '已取消导出' };
const exportCards = new Map(), exportVersions = new Map(), exportStates = new Map(), mediaReads = new Map();
const recordingCards = new Map(), recordingSignals = new Map();
const detailId = new URLSearchParams(location.search).get('id');
let listRevision = 0, listRefresh = null;
const listPageSize = 20;
let listPages = 1, listNext = null, listHasMore = false, listedRecords = [], listController;
let ownerTabId, pageClosed = false;
let previewResource = null, previewController = null, previewRevision = 0;
let saveController = null, saveCancelling = false, saveCommitted = false, mediaBusy = false, activityRevision = 0, lastPlaybackTime = 0;
const directPending = new Set(), mediaActivity = { web: false, desktop: false, reserved: false };
const previewOwner = crypto.randomUUID();
const previewChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('yinglu-library-media') : null;
function renderMediaControls() {
  if (!detailId) return;
  $('load-preview').disabled = exporting || mediaBusy || retryingExport;
  $('export-file').disabled = exporting || mediaBusy || retryingExport;
  $('download').setAttribute('aria-disabled', String(exporting || mediaBusy));
  if (mediaBusy) {
    $('preview-note').hidden = false;
    $('preview-note').textContent = '正在录制或转换，回看已释放以减少资源竞争；处理完成后可重新载入。';
  }
  renderExport();
}
function updateActivity(values) {
  Object.assign(mediaActivity, values);
  const next = Object.values(mediaActivity).some(Boolean);
  if (next === mediaBusy) return;
  mediaBusy = next;
  if (next && detailId) {
    if (!saveCommitted) saveController?.abort(new DOMException('开始录制或转换，已取消保存准备', 'AbortError'));
    releasePreview().catch(showError);
  }
  renderMediaControls();
}
const activitySignals = new Map();
function observeActivity(source, state) {
  if (!state || !detailId) return;
  const signature = JSON.stringify([state.id, state.sessionId, state.status]);
  if (activitySignals.get(source) === signature) return;
  activitySignals.set(source, signature); activityRevision++;
  // Pause immediately; only the coordinator snapshot may discard resources.
  // Delayed messages from an old session cannot latch a false busy state.
  if (['preparing', 'recording', 'paused', 'saving'].includes(state.status)) $('player').pause();
  activeIds().catch(showError);
}
function pauseOtherPreviews() { previewChannel?.postMessage({ owner: previewOwner }); }
if (previewChannel) previewChannel.onmessage = event => {
  if (!event.data || event.data.owner === previewOwner || !detailId) return;
  if (previewResource || previewController) releasePreview().catch(showError);
};
const ownerReady = extension && chrome.tabs?.getCurrent ? chrome.tabs.getCurrent().then(tab => { ownerTabId = tab?.id; }).catch(() => {}) : Promise.resolve();
async function request(type, data = {}, { signal, timeoutMs = 10000, onLate } = {}) {
  const options = { signal, timeoutMs, message: '录制库连接超时，请重试。' };
  await bounded(() => ownerReady, options);
  const response = await bounded(() => chrome.runtime.sendMessage({ target: 'background', type, tabId: ownerTabId, ...data }), { ...options, onLate });
  if (!response?.ok) throw new Error(response?.error || (type === 'GET_ACTIVE_RECORDINGS' ? '无法确认录制状态，请稍后刷新后重试' : '操作未完成，请稍后重试'));
  return response;
}
async function withMediaRead(recordingId, run, { signal } = {}) {
  const token = crypto.randomUUID(), controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const lease = { recordingId, token, controller, timer: null, renewing: null }; mediaReads.set(token, lease);
  const release = () => request('MEDIA_READ_RELEASE', { recordingId, token }, { timeoutMs: 3000 }).catch(() => {});
  try {
    if (extension) {
      await request('MEDIA_READ_ACQUIRE', { recordingId, token }, { signal: controller.signal, onLate: release });
      lease.timer = setInterval(() => {
        if (lease.renewing || controller.signal.aborted) return;
        lease.renewing = request('MEDIA_READ_RENEW', { recordingId, token }, { signal: controller.signal, onLate: release })
          .catch(error => controller.abort(error)).finally(() => { lease.renewing = null; });
        return lease.renewing;
      }, 15000);
    }
    if (pageClosed) controller.abort();
    controller.signal.throwIfAborted();
    const result = await run(controller.signal);
    await bounded(() => lease.renewing, { signal: controller.signal, timeoutMs: 10000 });
    controller.signal.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    clearInterval(lease.timer); mediaReads.delete(token);
    if (extension) {
      const released = release();
      if (!controller.signal.aborted) await bounded(() => released, { signal: controller.signal, timeoutMs: 3000 }).catch(() => {});
    }
  }
}
async function releasePreview() {
  previewRevision++; previewController?.abort();
  const resource = previewResource; previewResource = null; url = undefined;
  const player = $('player');
  if (Number.isFinite(player.currentTime) && player.currentTime < 1e9) lastPlaybackTime = player.currentTime;
  player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true;
  $('download').removeAttribute('href'); $('close-preview').hidden = true; $('load-preview').hidden = false;
  $('preview-note').hidden = false;
  $('preview-note').textContent = '预览已释放，需要时可重新载入。原始视频仍保存在录制库。';
  renderMediaControls();
  await resource?.cleanup();
}
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const measured = (value, suffix = '', digits = 1) => numeric(value) ? `${value.toFixed(digits)}${suffix}` : '未采集';
function exportText(state) {
  if (!state?.status) return '已保存在录制库，可回看，需要时再选择下载。';
  const progress = state.progress || state;
  const percent = numeric(progress?.percent) ? ` · ${Math.max(0, Math.min(100, progress.percent)).toFixed(0)}%` : '';
  const bytes = !percent && numeric(progress?.bytes) ? ` · ${fileSize(progress.bytes)}${numeric(progress.total) ? ` / ${fileSize(progress.total)}` : ''}` : '';
  const cancelled = state.status === 'cancelled' || state.status === 'error' && String(state.error || '').startsWith('已取消');
  const label = cancelled ? '已取消导出' : state.status === 'preparing' && progress.phase === 'converting' ? '正在本机转换视频' : exportLabels[state.status] || '保存状态未知';
  return `${label}${state.format ? ` · ${state.format === 'original' ? '原始视频' : String(state.format).toUpperCase()}` : ''}${percent || bytes}${state.status === 'error' && state.error ? `：${state.error}` : ''}${state.cleanupPending ? ' · 正在结束本机文件读写，请稍后重试' : ''}`;
}
function renderExport() {
  $('auto-export-status').textContent = exportText(currentRecord?.export);
  $('retry-export').hidden = !extension || currentRecord?.export?.status !== 'error';
  $('retry-export').disabled = exporting || retryingExport || !!currentRecord?.export?.cleanupPending;
  $('retry-export').textContent = retryingExport ? '正在重试…' : '重试导出';
  const pending = ['queued', 'preparing', 'converting', 'downloading'].includes(currentRecord?.export?.status);
  $('cancel-export').hidden = saveCommitted || !saveController && (!extension || !pending);
  $('cancel-export').disabled = retryingExport || saveCancelling;
  $('cancel-export').textContent = saveController ? saveCancelling ? '正在取消保存…' : '取消保存' : '取消导出';
  $('convert-mp4').hidden = !extension || extensionForMime(currentRecord?.mimeType) === 'mp4';
  $('convert-mp4').disabled = exporting || mediaBusy || retryingExport || pending || !isRecordingFormatSupported('mp4');
  $('conversion-note').hidden = $('convert-mp4').hidden;
  $('conversion-note').textContent = isRecordingFormatSupported('mp4') ? '转换在本机进行，耗时通常接近视频时长。转换失败时原视频仍保留。' : '当前浏览器不支持 MP4 编码，仍可下载原始视频。';
}
function applyExport(id, value) {
  if (!value) return;
  exportStates.set(id, value);
  exportVersions.set(id, (exportVersions.get(id) || 0) + 1);
  if (exportCards.has(id)) exportCards.get(id).textContent = exportText(value);
  if (currentRecord?.id === id) { exportRevision++; currentRecord = { ...currentRecord, export: value }; renderExport(); renderDiagnostics(); }
}
async function refreshExport(id) {
  if (!extension) return;
  const revision = exportVersions.get(id) || 0;
  const response = await request('GET_EXPORT_STATE', { recordingId: id });
  if (revision === (exportVersions.get(id) || 0)) applyExport(id, response.export);
}
function phaseSummary(samples, phase, label) {
  const entries = samples.filter(entry => entry?.phase === phase && entry.sample).map(entry => entry.sample);
  if (!entries.length) return `${label}：未采集。`;
  const visible = entries.filter(sample => sample.visibility === 'visible' && numeric(sample.raf?.intervalCount) && sample.raf.intervalCount > 0 && numeric(sample.raf.meanMs) && sample.raf.meanMs > 0);
  const intervals = visible.reduce((sum, sample) => sum + sample.raf.intervalCount, 0);
  const intervalMs = visible.reduce((sum, sample) => sum + sample.raf.meanMs * sample.raf.intervalCount, 0);
  const cadence = intervals ? `${measured(1000 * intervals / intervalMs, ' 次/秒')}（${intervals} 个间隔${visible.some(sample => sample.enoughData) ? '' : '，样本不足'}）` : '未采集';
  const longTasks = entries.filter(sample => sample.longTasks?.supported && numeric(sample.longTasks.count) && numeric(sample.longTasks.totalMs));
  const tasks = longTasks.length ? `${longTasks.reduce((sum, sample) => sum + sample.longTasks.count, 0)} 次 / ${measured(longTasks.reduce((sum, sample) => sum + sample.longTasks.totalMs, 0), ' ms')}` : '未采集或浏览器不支持';
  const context = entries.filter(sample => numeric(sample.webglContextLost));
  const lost = context.length ? `${context.reduce((sum, sample) => sum + sample.webglContextLost, 0)} 次` : '未采集';
  const hidden = entries.filter(sample => sample.visibility !== 'visible').length;
  return `${label}：可见页 RAF 节拍 ${cadence}；长任务 ${tasks}；WebGL 上下文丢失 ${lost}${hidden ? `；含 ${hidden} 段非可见页面样本` : ''}。`;
}
function diagnosticsData(record) {
  return { version: 1, recording: { id: record.id, title: record.title, createdAt: record.createdAt, duration: record.duration,
    width: record.width, height: record.height, targetFps: record.fps, status: record.status },
    performance: record.performance ?? null, pageDiagnostics: record.pageDiagnostics ?? null, export: record.export ?? null };
}
function renderDiagnostics() {
  if (!currentRecord) return;
  const p = currentRecord.performance, video = p?.video, canvas = video?.canvas, storage = p?.storage;
  const audioModes = { none: '无音频', direct: '直接音轨', mixed: '混合音轨' };
  const audio = p?.audio?.mode ? audioModes[p.audio.mode] || p.audio.mode : '未采集';
  const canvasAverage = numeric(canvas?.drawnFrames) && canvas.drawnFrames > 0 && numeric(canvas.drawSubmitMsTotal) ? canvas.drawSubmitMsTotal / canvas.drawnFrames : null;
  const settings = value => value ? JSON.stringify(value) : '未采集';
  $('performance-summary').textContent = [
    `视频路径：${video?.pipeline || '未采集'}；目标帧率设置：${measured(video?.requestedFrameRate, '', 0)}。`,
    `来源轨道设置：${settings(video?.sourceSettings)}；输出轨道设置：${settings(video?.outputSettings)}。`,
    `Canvas 提交：${measured(canvas?.drawnFrames, ' 次', 0)}；平均 ${measured(canvasAverage, ' ms')}；最长 ${measured(canvas?.drawSubmitMsMax, ' ms')}。`,
    `本地写入：最长 ${measured(storage?.chunkWriteMsMax, ' ms')}；峰值待写 ${numeric(storage?.peakPendingBytes) ? fileSize(storage.peakPendingBytes) : '未采集'} / ${measured(storage?.peakPendingChunks, ' 段', 0)}；失败 ${measured(storage?.chunkWritesFailed, ' 次', 0)}。`,
    `音频路径：${audio}。`
  ].join('\n');
  const samples = Array.isArray(currentRecord.pageDiagnostics?.samples) ? currentRecord.pageDiagnostics.samples : [];
  $('page-performance-summary').textContent = [['baseline', '录制前'], ['recording', '录制中'], ['recovery', '停止后']].map(([phase, label]) => phaseSummary(samples, phase, label)).join('\n');
  $('diagnostics-json').textContent = JSON.stringify(diagnosticsData(currentRecord), null, 2);
}
async function refreshDiagnostics(id) {
  if (id !== currentRecord?.id) return;
  const revision = ++diagnosticsRevision;
  const record = await getRecording(id);
  if (!record || id !== currentRecord?.id || revision !== diagnosticsRevision) return;
  currentRecord = { ...currentRecord, performance: record.performance, pageDiagnostics: record.pageDiagnostics };
  renderDiagnostics();
}
async function activeIds(includeExports = false, { signal } = {}) {
  if (!extension) return [];
  const revision = activityRevision;
  const response = await request('GET_ACTIVE_RECORDINGS', {}, { signal });
  if (!response?.ok || !Array.isArray(response.ids)) throw new Error(response?.error || '无法确认录制状态，请稍后刷新后重试');
  if (revision === activityRevision) updateActivity(response.mediaActivity || { web: response.ids.length > 0, desktop: false, reserved: false });
  return includeExports ? [...response.ids, ...(Array.isArray(response.exportIds) ? response.exportIds : [])] : response.ids;
}
async function remove(id) {
  if ((await activeIds(true)).includes(id)) throw new Error('这段视频仍在录制或导出，请完成后再删除');
  if (!confirm('删除这段本地录制？此操作不能撤销，已下载的文件不受影响。')) return;
  if (extension) await request('DELETE_RECORDING', { recordingId: id });
  else await deleteRecording(id);
  location.href = 'library.html';
}
async function showStorage() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (!Number.isFinite(estimate?.quota) || !Number.isFinite(estimate?.usage)) return;
    const remaining = Math.max(0, estimate.quota - estimate.usage);
    $('storage').hidden = false;
    $('storage').textContent = `本地已用 ${fileSize(estimate.usage)} · 浏览器估算可用 ${fileSize(remaining)}${remaining < 256 * 1024 * 1024 ? ' · 空间较少，请先导出并清理旧录制' : ''}`;
  } catch { /* A browser may withhold its storage estimate. */ }
}
function renderRecordings(records, active) {
  const present = new Set(records.map(record => record.id)), nodes = [];
  for (const [id] of recordingCards) if (!present.has(id)) {
    recordingCards.delete(id); exportCards.delete(id); exportStates.delete(id);
  }
  for (const r of records) {
    let entry = recordingCards.get(r.id);
    if (!entry) {
      const card = document.createElement('section'); card.className = 'card library-card';
      const tag = document.createElement('span'); tag.className = 'tag';
      const title = document.createElement('h2'), meta = document.createElement('p');
      const saved = document.createElement('p'); saved.className = 'micro';
      const row = document.createElement('div'); row.className = 'row';
      const link = document.createElement('a'); link.textContent = '回看录制 ↗'; link.href = `library.html?id=${encodeURIComponent(r.id)}`;
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = '删除'; del.onclick = () => remove(r.id).catch(showError);
      row.append(link, del); card.append(tag, title, meta, saved, row);
      entry = { card, tag, title, meta, saved, del }; recordingCards.set(r.id, entry); exportCards.set(r.id, saved);
      refreshExport(r.id).catch(showError);
    }
    entry.tag.textContent = active.includes(r.id) ? '正在录制' : r.status === 'complete' ? '已完成' : '可尝试恢复';
    entry.title.textContent = r.title;
    entry.meta.textContent = `${clockText(r.duration)} · ${fileSize(r.bytes)}\n${new Date(r.createdAt).toLocaleString('zh-CN')}`;
    entry.saved.textContent = exportText(exportStates.get(r.id) || r.export);
    entry.del.disabled = active.includes(r.id);
    nodes.push(entry.card);
  }
  const list = $('list');
  if (!nodes.length) list.replaceChildren('还没有视频。打开项目网页，点击映录扩展图标，开始第一段录制。');
  else {
    if (list.firstChild?.nodeType === 3) list.replaceChildren();
    nodes.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
    while (list.children.length > nodes.length) list.lastElementChild.remove();
  }
}
function refreshRecordings({ more = false } = {}) {
  if (detailId || pageClosed || document.hidden) return Promise.resolve();
  if (more && (listRefresh || !listHasMore)) return listRefresh || Promise.resolve();
  ++listRevision;
  if (listRefresh) return listRefresh;
  const appendCursor = more ? listNext : null;
  const targetPages = listPages + (more ? 1 : 0);
  let canceled = false;
  listController = new AbortController();
  $('load-more').disabled = true; $('retry-list').hidden = true;
  $('list-status').textContent = more ? '正在载入更多…' : '正在读取录制…';
  listRefresh = (async () => {
    let revision, append = more;
    do {
      revision = listRevision;
      // Messages only invalidate the list. Stored records and the coordinator
      // decide its contents, so delayed messages cannot overwrite another video.
      const active = await activeIds();
      let records = append ? [...listedRecords] : [], next = append ? appendCursor : null, hasMore;
      let pages = append ? listPages : 0;
      do {
        const page = await listRecordingPage({ limit: listPageSize, before: next, signal: listController.signal });
        records.push(...page.records); next = page.next; hasMore = page.hasMore; pages++;
      } while (!append && hasMore && pages < targetPages && revision === listRevision && !pageClosed);
      if (revision === listRevision && !pageClosed) {
        listedRecords = records; listNext = next; listHasMore = hasMore; listPages = Math.max(1, pages);
        renderRecordings(records, active);
        $('load-more').hidden = !hasMore;
        $('list-status').textContent = records.length ? `已显示 ${records.length} 段录制${hasMore ? '' : '，已全部载入'}` : '';
        $('error').hidden = true;
      }
      append = false;
    } while (revision !== listRevision && !pageClosed);
  })().catch(error => {
    canceled = error.name === 'AbortError';
    if (error.name !== 'AbortError') { $('retry-list').hidden = false; $('list-status').textContent = '读取未完成，可重试。'; throw error; }
  }).finally(() => {
    listRefresh = null; listController = null; $('load-more').disabled = false;
    // Visibility can return before the canceled native read reports failure.
    if (canceled && !pageClosed && !document.hidden) queueMicrotask(() => refreshRecordings().catch(showError));
  });
  return listRefresh;
}
$('load-more').onclick = () => refreshRecordings({ more: true }).catch(showError);
$('retry-list').onclick = () => refreshRecordings().catch(showError);
const recordingSignature = state => JSON.stringify([state?.id, state?.sessionId, state?.status]);
function recordingChanged(source, state) {
  observeActivity(source, state);
  if (detailId || !state) return;
  const signature = recordingSignature(state);
  if (recordingSignals.get(source) === signature) return;
  recordingSignals.set(source, signature);
  refreshRecordings().catch(showError);
}
async function main() {
  const id = detailId;
  const active = id ? await activeIds() : [];
  if (id) {
    const r = await getRecording(id);
    if (!r) throw new Error('录制不存在或已被删除');
    if (active.includes(id)) throw new Error('视频还在录制中，请结束录制后刷新此页');
    currentRecord = r; renderExport(); renderDiagnostics();
    refreshExport(id).catch(showError);
    $('download-diagnostics').onclick = () => {
      if (diagnosticsUrl) URL.revokeObjectURL(diagnosticsUrl);
      diagnosticsUrl = URL.createObjectURL(new Blob([JSON.stringify(diagnosticsData(currentRecord), null, 2)], { type: 'application/json' }));
      $('download-diagnostics').href = diagnosticsUrl;
      $('download-diagnostics').download = `映录-诊断-${new Date(r.createdAt).toISOString().replace(/[:.]/g, '-')}.json`;
    };
    const startExport = async format => {
      if (retryingExport || exporting || !extension) return;
      retryingExport = true; renderExport();
      const revision = exportRevision;
      try {
        if (format === 'mp4') await releasePreview();
        const response = await request('RETRY_EXPORT', { recordingId: id, ...(format ? { format } : {}) });
        if (!response?.ok) throw new Error(response?.error || '无法重试导出，请稍后再试');
        if (revision === exportRevision) currentRecord = { ...currentRecord, export: response.export || { status: 'queued' } };
        renderDiagnostics();
      } catch (error) { showError(error); }
      finally { retryingExport = false; renderExport(); }
    };
    $('retry-export').onclick = () => startExport(currentRecord.export?.format);
    $('convert-mp4').onclick = () => startExport('mp4');
    $('cancel-export').onclick = async () => {
      if (saveController && !saveCommitted) { saveCancelling = true; saveController.abort(); renderExport(); return; }
      if (retryingExport) return;
      retryingExport = true; renderExport();
      const revision = exportRevision;
      try { const response = await request('EXPORT_CANCEL', { recordingId: id });
        if (revision === exportRevision) applyExport(id, response.export || { ...currentRecord.export, status: 'cancelled' });
      } catch (error) { showError(error); }
      finally { retryingExport = false; renderExport(); }
    };
    $('heading').textContent = r.title;
    $('description').textContent = r.status === 'complete' ? '录制已保存在本地录制库，可直接回看；需要时再选择下载。' : '这段录制曾被中断。以下视频由已保存的片段恢复，尾部可能不完整。';
    const ext = extensionForMime(r.mimeType), label = ext.toUpperCase(), mime = ext === 'mp4' ? 'video/mp4' : 'video/webm';
    const filename = `映录-${new Date(r.createdAt).toISOString().replace(/[:.]/g, '-')}.${ext}`;
    $('download').textContent = `下载 ${label} 视频 ↓`; $('export-file').textContent = `直接保存 ${label} 文件 ↓`;
    const setBusy = value => {
      exporting = value;
      $('delete').disabled = value;
      $('close-preview').disabled = value && !previewController;
      renderMediaControls();
    };
    const progress = bytes => { $('export-status').textContent = `已读取 ${fileSize(bytes)} / ${fileSize(r.bytes)}`; };
    const loadPreview = async () => {
      if (url || exporting || pageClosed || mediaBusy) return;
      const controller = previewController = new AbortController(), revision = ++previewRevision;
      let resource;
      $('close-preview').hidden = false; $('close-preview').textContent = '取消载入';
      setBusy(true); pauseOtherPreviews();
      try {
        if ((await activeIds(false, { signal: controller.signal })).includes(id)) throw new Error('视频还在录制中，请先结束录制');
        if (mediaBusy) throw new DOMException('正在录制或转换，回看暂缓', 'AbortError');
        await withMediaRead(id, async signal => {
          resource = await prepareRecordingPreview(id, { onProgress: progress, signal });
        }, { signal: controller.signal });
        if (pageClosed || controller.signal.aborted || revision !== previewRevision) return;
        previewResource = resource; url = resource.url; $('player').src = url; $('player').hidden = false;
        $('download').href = url; $('load-preview').hidden = true; $('preview-note').hidden = true;
        $('error').hidden = true;
        $('export-status').textContent = resource.storage === 'opfs' ? '已从本机临时文件载入，可回看或下载；释放预览后清理临时文件。' : '视频已载入，可预览或下载。';
      } catch (error) {
        if (error.name === 'AbortError') $('export-status').textContent = '已取消载入，原视频保留。';
        else throw error;
      } finally {
        if (resource && resource !== previewResource) await resource.cleanup().catch(() => {});
        if (previewController === controller) previewController = null;
        if (!previewResource) { $('load-preview').hidden = false; $('preview-note').hidden = false; }
        $('close-preview').hidden = !previewResource; $('close-preview').textContent = '释放预览'; setBusy(false);
      }
    };
    $('close-preview').onclick = () => releasePreview().catch(showError);
    $('download').download = filename;
    $('download').onclick = async event => {
      if (exporting || mediaBusy) { event.preventDefault(); return; }
      if (!url) {
        event.preventDefault();
        try { await loadPreview(); if (url && !pageClosed) $('download').click(); } catch (e) { showError(e); }
      }
    };
    $('load-preview').onclick = () => loadPreview().catch(showError);
    $('export-file').hidden = typeof globalThis.showSaveFilePicker !== 'function';
    $('export-file').onclick = async () => {
      if (exporting || mediaBusy || retryingExport || pageClosed) return;
      if (directPending.size) { showError(new Error('上一项保存仍在结束本机读写，请稍后重试；原视频保留。')); return; }
      const controller = saveController = new AbortController(); saveCancelling = saveCommitted = false;
      let writable;
      setBusy(true);
      try {
        // Invoke the picker in the click gesture; no time limit on user choice.
        const picked = showSaveFilePicker({ suggestedName: filename, types: [{ description: `${label} 视频`, accept: { [mime]: [`.${ext}`] } }] });
        const handle = await bounded(() => picked, { signal: controller.signal, timeoutMs: 0 });
        if ((await activeIds(false, { signal: controller.signal })).includes(id)) throw new Error('视频还在录制中，请先结束录制');
        if (mediaBusy) throw new DOMException('正在录制或转换，已取消本次保存准备', 'AbortError');
        await withMediaRead(id, async signal => {
          writable = await createFileResource({ handle, signal, pendingCleanups: directPending });
          await writeRecordingTo(id, writable, { onProgress: progress, signal });
          signal.throwIfAborted(); await writable.close(); saveCommitted = true; renderExport();
          $('export-status').textContent = '视频已保存到所选文件。';
        }, { signal: controller.signal });
        controller.signal.throwIfAborted();
        $('export-status').textContent = '视频已保存到所选文件。';
      } catch (e) {
        if (e.name === 'AbortError') $('export-status').textContent = '已取消保存，原视频保留。';
        else { $('export-status').textContent = '保存未完成，请重试。'; showError(e); }
      } finally {
        await writable?.cleanup();
        if (saveController === controller) saveController = null;
        saveCancelling = saveCommitted = false; setBusy(false);
      }
    };
    $('metadata').textContent = `${clockText(r.duration)} · ${r.width} × ${r.height} · 目标 ${r.fps} FPS · ${fileSize(r.bytes)} · ${new Date(r.createdAt).toLocaleString('zh-CN')}`;
    $('preview').hidden = false;
    $('delete').onclick = () => remove(id).catch(showError);
    const video = $('player');
    video.addEventListener('loadedmetadata', () => {
      // Timesliced WebM may omit duration; ask the browser to discover the last timestamp.
      if (video.duration === Infinity) {
        video.addEventListener('timeupdate', () => { video.currentTime = lastPlaybackTime; }, { once: true });
        video.currentTime = 1e10;
      } else if (lastPlaybackTime > 0) video.currentTime = Math.min(lastPlaybackTime, Math.max(0, video.duration - .1));
    });
    video.addEventListener('play', () => { if (mediaBusy) video.pause(); else pauseOtherPreviews(); });
    if (r.bytes > PREVIEW_BLOB_LIMIT) {
      $('load-preview').hidden = false; $('preview-note').hidden = false;
      $('download').textContent = `载入后下载 ${label} ↓`;
      $('preview-note').textContent = '长视频按片段写入本机临时文件后回看，需要额外磁盘空间；可取消载入或释放预览，原视频保留。';
    } else if (!mediaBusy) await loadPreview();
    renderMediaControls();
  } else {
    await refreshRecordings();
  }
}
function showError(e) { $('error').textContent = e.message; $('error').hidden = false; }
if (extension) chrome.runtime.onMessage?.addListener(message => {
  if (message.type === 'EXPORT_STATE' && message.export) applyExport(message.recordingId, message.export);
  if (message.type === 'PERF_UPDATED' && message.id === currentRecord?.id) refreshDiagnostics(message.id).catch(showError);
  if (!message.target || message.target === 'panel') {
    if (message.type === 'STATE') recordingChanged('web', message.state);
    if (message.type === 'DESKTOP_RECOVERED') recordingChanged('desktop', message.state);
  }
});
if (extension) chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.captureSession) { activityRevision++; updateActivity({ reserved: !!changes.captureSession.newValue }); }
  for (const [key, source] of [['recording', 'web'], ['desktopRecording', 'desktop']]) {
    const change = changes[key];
    if (change && recordingSignature(change.newValue) !== recordingSignature(change.oldValue)) recordingChanged(source, change.newValue || {});
  }
});
const refreshActivity = () => { if (detailId) activeIds().catch(showError); else refreshRecordings().catch(showError); };
addEventListener('focus', refreshActivity);
document.addEventListener?.('visibilitychange', () => {
  if (document.hidden) { $('player').pause(); previewController?.abort(); listController?.abort(); }
  else refreshActivity();
});
main().catch(showError);
cleanupPreviewFiles({ olderThanMs: 0 }).catch(() => {});
showStorage();
addEventListener('beforeunload', event => { if (exporting) { event.preventDefault(); event.returnValue = ''; } });
addEventListener('pagehide', () => {
  listController?.abort();
  pageClosed = true; saveController?.abort(); previewChannel?.close();
  for (const lease of mediaReads.values()) {
    lease.controller.abort(); clearInterval(lease.timer);
    if (extension) request('MEDIA_READ_RELEASE', { recordingId: lease.recordingId, token: lease.token }).catch(() => {});
  }
  releasePreview().catch(() => {}); if (diagnosticsUrl) URL.revokeObjectURL(diagnosticsUrl);
});
