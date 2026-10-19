import { pendingFileCleanupCount } from './lib/file-resource.js';
import { prepareRecordingExport } from './lib/export.js';
import { bounded } from './lib/async.js';

const recordingId = new URLSearchParams(location.search).get('id');
const token = new URLSearchParams(location.search).get('token');
const format = new URLSearchParams(location.search).get('format') || 'original';
const status = document.getElementById('status');
const controller = new AbortController();
let resource, preparation, finishing = false, cleanupPromise;
const cleanup = prepared => prepared ? cleanupPromise ||= prepared.cleanup() : Promise.resolve();
let progress = { phase: 'preparing', bytes: 0 }, lastProgressSent = 0, progressWrites = Promise.resolve();
const currentTab = chrome.tabs.getCurrent();
const notify = async (type, data = {}) => {
  const signal = ['EXPORT_PROGRESS', 'EXPORT_READY'].includes(type) ? controller.signal : undefined;
  const options = { signal, timeoutMs: 5000, message: '导出页面连接超时，原视频保留。' };
  const tab = await bounded(() => currentTab, options);
  return bounded(() => chrome.runtime.sendMessage({ target: 'background', type, recordingId, token, tabId: tab.id, ...data }), options);
};
const reportProgress = force => {
  if (finishing || !force && Date.now() - lastProgressSent < 1000) return progressWrites;
  lastProgressSent = Date.now(); const snapshot = { ...progress };
  progressWrites = progressWrites.then(() => notify('EXPORT_PROGRESS', snapshot)).catch(() => {});
  return progressWrites;
};
const heartbeat = setInterval(() => reportProgress(true), 5000); heartbeat.unref?.();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'exporter' || message.type !== 'EXPORT_FINISH' || message.recordingId !== recordingId || message.token !== token) return;
  finishing = true; controller.abort();
  clearInterval(heartbeat);
  (async () => {
    // Await only resource preparation. Waiting for an EXPORT_READY/ERROR reply
    // here would deadlock a background handler that is asking us to clean up.
    const prepared = await preparation?.catch(() => undefined);
    await cleanup(prepared);
    const pending = pendingFileCleanupCount() > 0;
    reply(pending ? { ok: false, pending: true, error: '正在结束本机文件读写，原视频保留。' } : { ok: true });
  })().catch(error => reply({ ok: false, error: error.message }));
  return true;
});

preparation = recordingId && token ? prepareRecordingExport(recordingId, { signal: controller.signal, format, token,
  onProgress: (bytes, total, details = {}) => { progress = { ...progress, bytes, total, ...details }; return reportProgress(false); }
}) : Promise.reject(new Error('缺少保存任务参数'));
preparation.then(async prepared => {
  resource = prepared;
  if (finishing) { await cleanup(prepared); return; }
  progress = { ...progress, phase: 'ready' }; await reportProgress(true);
  status.textContent = prepared.storage === 'opfs' ? '文件已准备，正在交给浏览器下载。' : '当前环境使用兼容方式准备下载，大视频可能占用较多内存。';
  if (finishing) { await cleanup(prepared); return; }
  const response = await notify('EXPORT_READY', { url: prepared.url, filename: prepared.filename, storage: prepared.storage, format: prepared.format });
  if (!response?.ok) throw new Error(response?.error || '浏览器未能开始保存');
  clearInterval(heartbeat);
}).catch(async error => {
  clearInterval(heartbeat);
  await cleanup(resource).catch(() => {});
  if (finishing) return;
  status.textContent = `保存失败：${error.message}。原始片段仍保存在录制库，可手动下载。`;
  await notify('EXPORT_ERROR', { error: error.message }).catch(() => {});
});

addEventListener('pagehide', () => {
  finishing = true; controller.abort();
  clearInterval(heartbeat);
  // Normal closure is coordinated through EXPORT_FINISH. This is best effort
  // for a user closing the page while preparation or a download is in progress.
  cleanup(resource).catch(() => {});
});
