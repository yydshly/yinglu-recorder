import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoExporter } from '../lib/auto-export.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function harness() {
  const h = { saved: {}, durable: {}, now: 1000000, tabs: new Map(), downloads: new Map(), records: new Map(), created: [], removed: [], started: [], finished: [], updates: [], nextTab: 10, nextDownload: 30 };
  h.chrome = {
    runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, sendMessage: async message => { h.finished.push(message); return h.finishGate ? h.finishGate.promise : { ok: true }; } },
    storage: { session: { get: async () => structuredClone(h.saved), set: async value => Object.assign(h.saved, structuredClone(value)) },
      local: { get: async () => structuredClone(h.durable), set: async value => Object.assign(h.durable, structuredClone(value)) } },
    tabs: {
      async create(options) { h.created.push(options); const tab = { id: ++h.nextTab, ...options }; h.tabs.set(tab.id, tab); return tab; },
      async get(id) { const tab = h.tabs.get(id); if (!tab) throw new Error('No tab'); return tab; },
      async query() { return [...h.tabs.values()]; },
      async remove(id) { h.removed.push(id); h.tabs.delete(id); }
    },
    downloads: {
      async download(options) {
        h.started.push(options); if (h.downloadError) throw h.downloadError;
        const id = ++h.nextDownload;
        h.downloads.set(id, { id, url: options.url, filename: `C:\\Downloads\\${options.filename}`, state: h.immediateComplete ? 'complete' : 'in_progress', byExtensionId: 'test' }); return id;
      },
      async search(query) { if (h.searchError) throw h.searchError; return [...h.downloads.values()].filter(item => query.id !== undefined ? item.id === query.id : item.url === query.url); },
      async cancel(id) { const item = h.downloads.get(id); if (item) item.state = 'interrupted'; }
    }
  };
  h.options = { chrome: h.chrome, now: () => h.now, updateRecord: async (id, patch) => { const record = h.records.get(id) || { id, status: 'complete', source: ['saved chunk'] }; h.records.set(id, { ...record, ...structuredClone(patch) }); }, onUpdate: message => h.updates.push(message) };
  h.controller = new AutoExporter(h.options);
  h.job = id => structuredClone(h.saved.autoExportJobs.find(job => job.recordingId === id));
  h.ready = (id, extra = {}, senderExtra = {}) => {
    const job = h.job(id);
    return h.controller.handleReady({ recordingId: id, token: job.token, tabId: job.tabId, url: `blob:chrome-extension://test/${id}`, filename: `录制-${id}.webm`, storage: 'opfs', ...extra },
      { id: 'test', url: h.chrome.runtime.getURL(`exporter.html?id=${id}&token=${job.token}`), tab: { id: job.tabId }, ...senderExtra });
  };
  return h;
}

test('重复终态只排一次，下载未完成不关闭导出页，后续任务串行启动', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); await h.controller.queueRecording('r1'); await h.controller.queueRecording('r2');
  assert.equal(h.created.length, 1); assert.equal(h.created[0].active, false); assert.equal(h.job('r2').status, 'queued');
  const result = await h.ready('r1'); assert.equal(result.ok, true); assert.equal(h.job('r1').status, 'downloading');
  assert.equal(h.finished.length, 0); assert.equal(h.removed.length, 0);
  assert.deepEqual(h.started[0], { url: 'blob:chrome-extension://test/r1', filename: '映录/录制-r1.webm', saveAs: false, conflictAction: 'uniquify' });
  await h.controller.changed({ id: result.downloadId, state: { current: 'complete' } });
  assert.equal(h.job('r1').status, 'complete'); assert.equal(h.created.length, 2); assert.equal(h.removed.length, 1);
  await h.controller.changed({ id: result.downloadId, state: { current: 'complete' } }); await h.controller.queueRecording('r1');
  assert.equal(h.started.length, 1); assert.equal(h.created.length, 2);
});

test('失败保留录制副本，显式重试产生新 token，缺少权限给出明确原因', async () => {
  const h = harness(); h.downloadError = new Error('Permission denied'); await h.controller.queueRecording('r1');
  const oldToken = h.job('r1').token; assert.equal((await h.ready('r1')).ok, false);
  assert.equal(h.job('r1').status, 'error'); assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
  h.downloadError = undefined; await h.controller.retry('r1'); assert.notEqual(h.job('r1').token, oldToken);
  assert.equal((await h.ready('r1')).ok, true);
  const missing = harness(); delete missing.chrome.downloads; await missing.controller.queueRecording('r1');
  assert.equal(missing.created.length, 0); assert.match(missing.job('r1').error, /下载权限/);
});

test('真实文档身份在失败后重试时重置，新导出页可以继续进度和开始下载', async () => {
  const h = harness(); h.chrome.runtime.getContexts = async () => [];
  h.downloadError = new Error('Permission denied');
  await h.controller.queueRecording('r1');
  assert.equal((await h.ready('r1', {}, { documentId: 'failed-document' })).ok, false);
  const failed = h.job('r1');
  assert.equal(failed.documentId, 'failed-document'); assert.equal(failed.status, 'error');
  h.downloadError = undefined; assert.equal((await h.controller.retry('r1')).ok, true);
  const retried = h.job('r1');
  assert.notEqual(retried.token, failed.token); assert.equal(retried.documentId, undefined);
  const sender = { id: 'test', url: h.tabs.get(retried.tabId).url, documentId: 'retry-document' };
  assert.equal((await h.controller.handleProgress({ recordingId: 'r1', token: retried.token, tabId: retried.tabId, bytes: 10 }, sender)).ok, true);
  assert.equal(h.job('r1').documentId, 'retry-document');
  assert.equal((await h.ready('r1', {}, { documentId: 'retry-document' })).ok, true);
  assert.equal(h.job('r1').status, 'downloading'); assert.equal(h.started.length, 2);
});

test('网页、过期 token、错误 tab、其他来源 Blob 与路径文件名不能触发下载副作用', async () => {
  const h = harness(); await h.controller.queueRecording('r1');
  for (const [message, sender] of [
    [{}, { id: 'foreign' }], [{}, { url: 'https://example.test/' }], [{ token: 'old' }, {}],
    [{ tabId: 999 }, {}], [{}, { tab: { id: 999 } }], [{ url: 'blob:https://example.test/file' }, {}],
    [{ filename: '../bad.webm' }, {}], [{ filename: 'bad\\file.webm' }, {}], [{ filename: 'bad.exe' }, {}]
  ]) assert.equal((await h.ready('r1', message, sender)).ok, false);
  assert.equal(h.started.length, 0); assert.equal(h.finished.length, 0); assert.equal(h.removed.length, 0);
  const job = h.job('r1');
  assert.equal((await h.controller.handleError({ recordingId: 'r1', token: 'old', error: 'fake' }, { id: 'test', url: h.tabs.get(job.tabId).url, tab: { id: job.tabId } })).ok, false);
  assert.equal(h.job('r1').status, 'preparing');
});

test('兼容没有 sender.tab 的扩展页，仍核对实际 tab URL 和 token', async () => {
  const h = harness(); await h.controller.queueRecording('r1');
  assert.equal((await h.ready('r1', {}, { tab: undefined })).ok, true);
  const moved = harness(); await moved.controller.queueRecording('r1'); moved.tabs.get(moved.job('r1').tabId).url = 'https://example.test/';
  assert.equal((await moved.ready('r1', {}, { tab: undefined })).ok, false); assert.equal(moved.started.length, 0);
});

test('下载中断要等 URL 清理确认后才关自己页，不关导航后的用户页面', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const started = await h.ready('r1'); h.finishGate = deferred();
  const pending = h.controller.changed({ id: started.downloadId, state: { current: 'interrupted' }, error: { current: 'FILE_NO_SPACE' } });
  await tick(); assert.equal(h.removed.length, 0); assert.equal(h.finished.length, 1);
  h.tabs.get(h.job('r1').tabId).url = 'https://example.test/'; h.finishGate.resolve({ ok: true }); await pending;
  assert.equal(h.removed.length, 0); assert.equal(h.job('r1').status, 'error'); assert.match(h.job('r1').error, /FILE_NO_SPACE/);
  assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
});

test('准备页被关闭标记失败，重复状态不会悄悄再下载', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const id = h.job('r1').tabId; h.tabs.delete(id);
  await h.controller.tabRemoved(id); assert.equal(h.job('r1').status, 'error');
  await h.controller.queueRecording('r1'); assert.equal(h.created.length, 1); assert.equal(h.started.length, 0);
  await h.controller.retry('r1'); assert.equal(h.created.length, 2);
});

test('服务重启恢复正在下载的任务，不新建页面或重复调用 download', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const started = await h.ready('r1');
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.created.length, 1); assert.equal(h.started.length, 1); assert.equal(h.finished.length, 0);
  h.downloads.get(started.downloadId).state = 'complete';
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.job('r1').status, 'complete'); assert.equal(h.started.length, 1); assert.equal(h.removed.length, 1);
});

test('重启时从已持久化 URL 找回尚未保存回执的下载编号', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const job = h.job('r1');
  Object.assign(h.saved.autoExportJobs[0], { resourceUrl: 'blob:chrome-extension://test/r1', filename: '映录/录制-r1.webm', storage: 'opfs' });
  h.downloads.set(88, { id: 88, url: 'blob:chrome-extension://test/r1', state: 'in_progress', byExtensionId: 'test' });
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.job('r1').downloadId, 88); assert.equal(h.job('r1').status, 'downloading'); assert.equal(h.started.length, 0);
  assert.equal(h.created.length, 1); assert.equal(h.job('r1').token, job.token);
});

test('重启时缺失准备页标记错误，不重复创建；完成回执前的快速下载也能收尾', async () => {
  const missing = harness(); await missing.controller.queueRecording('r1'); missing.tabs.clear();
  missing.controller = new AutoExporter(missing.options); await missing.controller.restore();
  assert.equal(missing.job('r1').status, 'error'); assert.equal(missing.created.length, 1);
  const fast = harness(); fast.immediateComplete = true; await fast.controller.queueRecording('r1'); const started = await fast.ready('r1');
  assert.equal(started.ok, true); assert.equal(fast.job('r1').status, 'complete'); assert.equal(fast.removed.length, 1);
  await fast.controller.changed({ id: started.downloadId, state: { current: 'complete' } }); assert.equal(fast.started.length, 1);
});

test('重启能找回已经创建但未持久化 tabId 的准备页', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const tabId = h.job('r1').tabId;
  h.saved.autoExportJobs[0].tabId = undefined;
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.job('r1').tabId, tabId); assert.equal(h.job('r1').status, 'preparing'); assert.equal(h.created.length, 1);
});

test('浏览器session清空后从local摘要核对完成下载，不重复下载', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); const started = await h.ready('r1');
  assert.equal(h.durable.autoExportJobs[0].downloadId, started.downloadId);
  assert.equal(h.durable.autoExportJobs[0].resourceUrl, undefined); assert.equal(h.durable.autoExportJobs[0].tabId, undefined);
  h.saved = {}; h.tabs.clear(); h.downloads.get(started.downloadId).state = 'complete';
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.job('r1').status, 'complete'); assert.equal(h.started.length, 1); assert.equal(h.created.length, 1);
  assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
});

test('浏览器重启丢失准备页时转为可重试错误，并继续持久排队任务', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); await h.controller.queueRecording('r2');
  h.saved = {}; h.tabs.clear(); h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal(h.job('r1').status, 'error'); assert.equal(h.job('r2').status, 'preparing');
  await h.controller.cancel('r2'); await h.controller.retry('r1'); assert.equal(h.job('r1').status, 'preparing');
});

test('旧版本IDB悬挂状态会核对downloadId并恢复为完成或可重试错误', async () => {
  const h = harness();
  h.downloads.set(88, { id: 88, state: 'complete', byExtensionId: 'test', filename: 'C:\\Downloads\\saved.webm' });
  assert.equal((await h.controller.recover('r1', { status: 'downloading', downloadId: 88 })).export.status, 'complete');
  assert.equal((await h.controller.recover('r2', { status: 'preparing' })).export.status, 'error');
  assert.equal((await h.controller.getState('r2')).export.status, 'error'); assert.equal(h.started.length, 0);
});

test('导航不会关闭用户页面，取消会停止自己的下载并启动下一任务', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); await h.controller.queueRecording('r2');
  const tabId = h.job('r1').tabId; h.tabs.get(tabId).url = 'https://example.test/';
  await h.controller.tabUpdated(tabId, { url: 'https://example.test/' }, h.tabs.get(tabId));
  assert.equal(h.job('r1').status, 'error'); assert.equal(h.tabs.has(tabId), true); assert.equal(h.job('r2').status, 'preparing');
  const started = await h.ready('r2'); await h.controller.cancel('r2');
  assert.equal(h.downloads.get(started.downloadId).state, 'interrupted'); assert.equal(h.job('r2').status, 'error');
  assert.deepEqual(h.records.get('r2').source, ['saved chunk']);
});

test('准备页心跳丢失或持续无字节进度会明确失败，不永久阻塞队列', async () => {
  const h = harness(); await h.controller.queueRecording('r1'); h.now += 120001; await h.controller.checkStalled();
  assert.equal(h.job('r1').status, 'error'); assert.match(h.job('r1').error, /未响应/);
  await h.controller.retry('r1');
  for (let i = 0; i < 6; i++) {
    const job = h.job('r1'); h.now += 59000;
    await h.controller.handleProgress({ recordingId: 'r1', token: job.token, tabId: job.tabId, bytes: 0, phase: 'preparing' },
      { id: 'test', url: h.tabs.get(job.tabId).url });
  }
  assert.equal(h.job('r1').status, 'error'); assert.match(h.job('r1').error, /没有新进度/);
});

test('转换秒数持续前进时不会因字节数未变而误判挂起', async () => {
  const h = harness(); await h.controller.queueRecording('r1', { format: 'mp4' });
  for (let second = 1; second <= 12; second++) {
    const job = h.job('r1'); h.now += 59000;
    const response = await h.controller.handleProgress({ recordingId: 'r1', token: job.token, tabId: job.tabId, phase: 'converting', bytes: 0, seconds: second },
      { id: 'test', url: h.tabs.get(job.tabId).url });
    assert.equal(response.ok, true);
  }
  assert.equal(h.job('r1').status, 'preparing'); assert.equal(h.job('r1').seconds, 12);
  assert.match(h.created[0].url, /format=mp4/);
  assert.equal((await h.ready('r1', { filename: 'wrong.webm' })).ok, false);
  assert.equal((await h.ready('r1', { filename: 'right.mp4' })).ok, true);
});

test('持久摘要版本较新时不被过期session会话覆盖', async () => {
  const h = harness(); await h.controller.queueRecording('r1');
  h.durable.autoExportJobs[0] = { ...h.durable.autoExportJobs[0], status: 'error', revision: 999, token: 'new-owner', error: 'stopped' };
  h.controller = new AutoExporter(h.options); await h.controller.restore();
  assert.equal((await h.controller.getState('r1')).export.status, 'error'); assert.equal(h.controller.jobs[0].token, 'new-owner');
});

test('转换准备钩子暂不允许时保持排队，后续检查再准备且原格式任务可先执行', async () => {
  const h = harness(); let allowed = false;
  h.controller = new AutoExporter({ ...h.options, canPrepare: async job => job.format !== 'mp4' || allowed });
  await h.controller.queueRecording('r1', { format: 'mp4' }); assert.equal(h.job('r1').status, 'queued'); assert.equal(h.created.length, 0);
  await h.controller.queueRecording('r2'); assert.equal(h.job('r2').status, 'preparing');
  await h.controller.cancel('r2'); allowed = true; await h.controller.checkStalled();
  assert.equal(h.job('r1').status, 'preparing'); assert.equal(h.created.length, 2);
});

test('只有自己的转换页消失后才释放占用，关闭失败不提前释放', async () => {
  const h = harness(), releases = [];
  h.controller = new AutoExporter({ ...h.options, onRelease: async job => releases.push(job.token) });
  await h.controller.queueRecording('r1', { format: 'mp4' }); const originalRemove = h.chrome.tabs.remove;
  h.chrome.tabs.remove = async () => { throw new Error('browser busy'); };
  await h.controller.cancel('r1'); assert.equal(releases.length, 0);
  h.chrome.tabs.remove = originalRemove; await h.controller.restore(); assert.equal(releases.length, 1);
});

test('元数据写入长期pending不阻塞取消，迟到写入后只提交最新状态且同一视频不并发patch', { timeout: 2000 }, async () => {
  const h = harness(), gate = deferred(), released = [];
  const applied = [], update = h.options.updateRecord;
  let calls = 0, inFlight = 0, maxInFlight = 0;
  h.controller = new AutoExporter({ ...h.options, metadataTimeoutMs: 10, onRelease: async job => released.push(job.token),
    updateRecord: async (id, patch) => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls === 2) await gate.promise;
      await update(id, patch); applied.push(patch.export.status); inFlight--;
    } });
  await h.controller.queueRecording('r1', { format: 'mp4' });
  const token = h.job('r1').token;
  assert.equal(h.job('r1').status, 'preparing'); assert.equal(calls, 2);
  assert.equal((await h.controller.cancel('r1')).ok, true);
  assert.equal(h.job('r1').status, 'error'); assert.equal(h.removed.length, 1);
  assert.deepEqual(released, [token]); assert.equal(calls, 2);
  gate.resolve(); await h.controller.metadataWrites.get('r1').done;
  assert.deepEqual(applied, ['queued', 'preparing', 'error']); assert.equal(maxInFlight, 1);
  assert.equal(h.records.get('r1').export.status, 'error'); assert.equal(h.records.get('r1').export.cleanupPending, false);
});

test('元数据等待超时后健康检查仍能停止失联准备并释放转换占用', { timeout: 2000 }, async () => {
  const h = harness(), gate = deferred(); let writes = 0, releases = 0;
  const update = h.options.updateRecord;
  h.controller = new AutoExporter({ ...h.options, metadataTimeoutMs: 10, onRelease: async () => { releases++; },
    updateRecord: async (id, patch) => { if (++writes === 2) await gate.promise; await update(id, patch); } });
  await h.controller.queueRecording('r1', { format: 'mp4' }); h.now += 120001;
  await h.controller.checkStalled(); assert.equal(h.job('r1').status, 'error'); assert.equal(releases, 1);
  gate.resolve(); await h.controller.metadataWrites.get('r1').done;
  assert.equal(h.records.get('r1').export.status, 'error'); assert.match(h.records.get('r1').export.error, /未响应/);
});

test('错误任务自动关页失败后，手动关页仍释放原token；清理完成前不覆盖token或准备后续任务', async () => {
  const h = harness(), releases = [];
  h.controller = new AutoExporter({ ...h.options, onRelease: async job => releases.push(job.token) });
  await h.controller.queueRecording('r1', { format: 'mp4' }); const original = h.job('r1');
  h.chrome.tabs.remove = async () => { throw new Error('browser busy'); };
  await h.controller.cancel('r1'); assert.equal(h.job('r1').cleanupPending, true);
  const retry = await h.controller.retry('r1'); assert.equal(retry.ok, false); assert.equal(h.job('r1').token, original.token);
  await h.controller.queueRecording('r2'); assert.equal(h.job('r2').status, 'queued');
  h.tabs.delete(original.tabId); await h.controller.tabRemoved(original.tabId);
  assert.deepEqual(releases, [original.token]); assert.equal(h.job('r1').cleanupPending, false); assert.equal(h.job('r2').status, 'preparing');
  assert.equal(h.records.get('r1').export.cleanupPending, false);
});

test('已完成任务关页失败后手动关闭也清理占用，旧关闭事件不会释放重试后的新会话', async () => {
  const h = harness(), releases = [];
  h.controller = new AutoExporter({ ...h.options, onRelease: async job => releases.push(job.token) });
  await h.controller.queueRecording('r1', { format: 'mp4' }); const original = h.job('r1');
  const started = await h.ready('r1', { filename: 'record.mp4' });
  const remove = h.chrome.tabs.remove; h.chrome.tabs.remove = async () => { throw new Error('browser busy'); };
  await h.controller.changed({ id: started.downloadId, state: { current: 'complete' } });
  assert.equal(h.job('r1').status, 'complete'); assert.equal(h.job('r1').cleanupPending, true); assert.equal(releases.length, 0);
  h.tabs.delete(original.tabId); await h.controller.tabRemoved(original.tabId);
  assert.deepEqual(releases, [original.token]); assert.equal(h.job('r1').status, 'complete');
  h.chrome.tabs.remove = remove; await h.controller.retry('r1'); const fresh = h.job('r1');
  assert.notEqual(fresh.token, original.token);
  const releasedBefore = releases.length; await h.controller.tabRemoved(original.tabId);
  assert.equal(releases.length, releasedBefore); assert.equal(h.job('r1').token, fresh.token); assert.equal(h.job('r1').status, 'preparing');
});

test('终态清理页导航后须确认旧文档消失才释放，不关闭导航后的用户页', async () => {
  const h = harness(), releases = []; let oldDocumentAlive = true;
  h.chrome.runtime.getContexts = async () => oldDocumentAlive ? [{ documentId: 'original-doc' }] : [];
  h.controller = new AutoExporter({ ...h.options, onRelease: async job => releases.push(job.token) });
  await h.controller.queueRecording('r1', { format: 'mp4' });
  let job = h.job('r1');
  await h.controller.handleProgress({ recordingId: 'r1', token: job.token, tabId: job.tabId, phase: 'converting', seconds: 1 },
    { id: 'test', url: h.tabs.get(job.tabId).url, documentId: 'original-doc' });
  h.chrome.tabs.remove = async () => { throw new Error('browser busy'); };
  await h.controller.cancel('r1'); await h.controller.queueRecording('r2');
  job = h.job('r1'); h.tabs.get(job.tabId).url = 'https://example.test/';
  await h.controller.tabUpdated(job.tabId, { url: 'https://example.test/' }, h.tabs.get(job.tabId));
  assert.equal(releases.length, 0); assert.equal(h.job('r1').cleanupPending, true); assert.equal(h.job('r2').status, 'queued');
  oldDocumentAlive = false; await h.controller.checkStalled();
  assert.deepEqual(releases, [job.token]); assert.equal(h.tabs.has(job.tabId), true); assert.equal(h.job('r1').cleanupPending, false);
  assert.equal(h.job('r2').status, 'preparing');
});

test('终态导出页同URL重载或被丢弃时，关闭未确认前保留锁，确认消失后继续队列', async () => {
  const h = harness(), releases = []; let oldDocumentAlive = true;
  h.chrome.runtime.getContexts = async () => oldDocumentAlive ? [{ documentId: 'old-doc' }] : [];
  h.controller = new AutoExporter({ ...h.options, onRelease: async job => releases.push(job.token) });
  await h.controller.queueRecording('r1', { format: 'mp4' }); const job = h.job('r1');
  await h.controller.handleProgress({ recordingId: 'r1', token: job.token, tabId: job.tabId, phase: 'converting', seconds: 1 },
    { id: 'test', url: h.tabs.get(job.tabId).url, documentId: 'old-doc' });
  const remove = h.chrome.tabs.remove; h.chrome.tabs.remove = async () => { throw new Error('browser busy'); };
  await h.controller.cancel('r1'); await h.controller.queueRecording('r2');
  await h.controller.tabUpdated(job.tabId, { status: 'loading' }, h.tabs.get(job.tabId));
  assert.equal(releases.length, 0); assert.equal(h.job('r1').cleanupPending, true);
  await h.controller.tabUpdated(job.tabId, { discarded: true }, { ...h.tabs.get(job.tabId), discarded: true });
  assert.equal(releases.length, 0); assert.equal(h.job('r2').status, 'queued');
  oldDocumentAlive = false; h.chrome.tabs.remove = remove; await h.controller.checkStalled();
  assert.deepEqual(releases, [job.token]); assert.equal(h.job('r1').cleanupPending, false); assert.equal(h.job('r2').status, 'preparing');
});

for (const area of ['local', 'session']) {
  test(`${area}任务镜像拒绝preparing写入时仍释放已领取的转换锁，保留源片段`, async () => {
    const h = harness(), released = []; let held = false;
    const set = h.chrome.storage[area].set;
    h.chrome.storage[area].set = async value => {
      if (value.autoExportJobs?.some(job => job.status === 'preparing')) throw new Error('QUOTA_BYTES quota exceeded');
      return set(value);
    };
    h.controller = new AutoExporter({ ...h.options, canPrepare: async () => { held = true; return true; },
      onRelease: async job => { released.push(job.token); held = false; } });
    await h.controller.retry('r1', { format: 'mp4' });
    assert.equal(h.controller.jobs[0].status, 'error'); assert.match(h.controller.jobs[0].error, /无法保存/);
    assert.equal(held, false); assert.equal(released.length, 1); assert.equal(h.created.length, 0);
    assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
    assert.equal((await h.controller.cancel('r1')).ok, true);
  });

  test(`${area}镜像长期pending不堵住取消与清理，迟到写入后按顺序补交最新终态`, { timeout: 2000 }, async () => {
    const h = harness(), gate = deferred(), released = [], applied = []; let held = false, inFlight = 0, maxInFlight = 0;
    h.controller = new AutoExporter({ ...h.options, storageTimeoutMs: 10,
      canPrepare: async () => { held = true; return true; }, onRelease: async job => { released.push(job.token); held = false; } });
    await h.controller.retry('r1', { format: 'mp4' }); const token = h.controller.jobs[0].token;
    const set = h.chrome.storage[area].set;
    h.chrome.storage[area].set = async value => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise; await set(value); applied.push(value.autoExportJobs[0].status); inFlight--;
    };
    assert.equal((await h.controller.cancel('r1')).ok, true);
    assert.equal(held, false); assert.deepEqual(released, [token]); assert.equal(h.removed.length, 1);
    assert.equal(h.controller.jobs[0].status, 'error'); assert.equal(h.controller.jobs[0].cleanupPending, false);
    gate.resolve(); await h.controller.mirrorWrites.get(area).done;
    const persisted = area === 'local' ? h.durable.autoExportJobs[0] : h.saved.autoExportJobs[0];
    assert.equal(persisted.status, 'error'); assert.equal(persisted.cleanupPending, false);
    assert.equal(maxInFlight, 1); assert.deepEqual(applied, ['error', 'error']);
    assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
  });

  test(`${area}准备写入pending超时后新token不能被迟到旧快照覆盖`, { timeout: 2000 }, async () => {
    const h = harness(), gate = deferred(), released = []; let delayed = false, inFlight = 0, maxInFlight = 0;
    const set = h.chrome.storage[area].set;
    h.chrome.storage[area].set = async value => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (!delayed && value.autoExportJobs?.some(job => job.status === 'preparing')) { delayed = true; await gate.promise; }
      await set(value); inFlight--;
    };
    h.controller = new AutoExporter({ ...h.options, storageTimeoutMs: 10, onRelease: async job => released.push(job.token) });
    await h.controller.retry('r1', { format: 'mp4' }); const oldToken = h.controller.jobs[0].token;
    assert.equal(h.controller.jobs[0].status, 'error'); assert.equal(h.created.length, 0);
    await h.controller.retry('r1', { format: 'mp4' }); const freshToken = h.controller.jobs[0].token;
    assert.notEqual(freshToken, oldToken); assert.equal(h.controller.jobs[0].status, 'error');
    gate.resolve(); await h.controller.mirrorWrites.get(area).done;
    const persisted = area === 'local' ? h.durable.autoExportJobs[0] : h.saved.autoExportJobs[0];
    assert.equal(persisted.token, freshToken); assert.equal(persisted.status, 'error'); assert.equal(maxInFlight, 1);
    assert.equal(released.includes(oldToken), true); assert.equal(released.includes(freshToken), true);
    await h.controller.retry('r1', { format: 'mp4' }); assert.equal(h.controller.jobs[0].status, 'preparing');
  });
}

test('升级时旧版无来源标记queued任务暂停，明确手动队列仍可跨会话准备', async () => {
  const h = harness();
  h.durable.autoExportJobs = [
    { recordingId: 'legacy', token: 'legacy-token', status: 'queued', format: 'original', createdAt: h.now },
    { recordingId: 'manual', token: 'manual-token', status: 'queued', source: 'manual', format: 'original', createdAt: h.now }
  ];
  await h.controller.restore();
  assert.equal(h.job('legacy').status, 'error'); assert.match(h.job('legacy').error, /旧版.*暂停/);
  assert.equal(h.job('manual').status, 'preparing'); assert.equal(h.created.length, 1);
  assert.match(h.created[0].url, /id=manual/); assert.equal(h.started.length, 0);
  assert.equal(h.records.get('legacy').export.status, 'error');
});

test('旧版preparing页被收起且不会因迟到READY下载，用户重试后标记manual并可正常导出', async () => {
  const h = harness(), token = 'legacy-token', tabId = 81;
  h.saved.autoExportJobs = [{ recordingId: 'r1', token, tabId, status: 'preparing', format: 'original', createdAt: h.now }];
  h.tabs.set(tabId, { id: tabId, url: h.chrome.runtime.getURL(`exporter.html?id=r1&token=${token}`) });
  await h.controller.restore();
  assert.equal(h.job('r1').status, 'error'); assert.equal(h.tabs.has(tabId), false); assert.equal(h.started.length, 0);
  assert.equal((await h.controller.handleReady({ recordingId: 'r1', token, tabId, url: 'blob:chrome-extension://test/r1', filename: 'r1.webm', storage: 'opfs' },
    { id: 'test', url: h.chrome.runtime.getURL(`exporter.html?id=r1&token=${token}`) })).ok, false);
  await h.controller.retry('r1'); assert.equal(h.job('r1').source, 'manual'); assert.notEqual(h.job('r1').token, token);
  assert.equal((await h.ready('r1')).ok, true); assert.equal(h.started.length, 1);
});

test('恢复旧任务时实际下载已开始则继续等待浏览器完成，不因来源未标记或旧页消失擅自取消', async () => {
  const h = harness();
  h.durable.autoExportJobs = [{ recordingId: 'r1', token: 'legacy-token', status: 'preparing', downloadId: 88, createdAt: h.now }];
  h.downloads.set(88, { id: 88, state: 'in_progress', byExtensionId: 'test' });
  await h.controller.restore();
  assert.equal(h.job('r1').status, 'downloading'); assert.equal(h.downloads.get(88).state, 'in_progress');
  assert.equal(h.created.length, 0); assert.equal(h.started.length, 0);
  h.downloads.get(88).state = 'complete'; await h.controller.changed({ id: 88, state: { current: 'complete' } });
  assert.equal(h.job('r1').status, 'complete');
});

test('仅IDB保留下载回执时恢复实际下载，不擅自取消已有浏览器任务', async () => {
  const h = harness(); h.downloads.set(88, { id: 88, state: 'in_progress', byExtensionId: 'test' });
  await h.controller.recover('r1', { status: 'downloading', downloadId: 88 });
  assert.equal(h.job('r1').status, 'downloading'); assert.equal(h.downloads.get(88).state, 'in_progress');
  assert.equal(h.created.length, 0); assert.equal(h.started.length, 0);
});

test('导出页面明确报告原生文件清理未结束时保留页面和占用，不提前关闭或重试',async t=>{
  const h=harness();let releases=0;h.controller.onRelease=async()=>{releases++;};
  await h.controller.retry('pending-file');const job=h.controller.jobs.find(j=>j.recordingId==='pending-file'),tabId=job.tabId;
  h.finishGate=deferred();h.finishGate.resolve({ok:false,pending:true,error:'native write pending'});
  await h.controller.cancel('pending-file');assert.equal(job.cleanupPending,true);assert.equal(h.tabs.has(tabId),true);assert.equal(releases,0);
  const before=h.created.length;const retry=await h.controller.retry('pending-file');assert.equal(retry.ok,false);assert.equal(h.created.length,before);
  h.finishGate=null;await h.controller.checkStalled();assert.equal(job.cleanupPending,false);assert.equal(h.tabs.has(tabId),false);assert.equal(releases,1);
  clearTimeout(h.controller.checkTimer);
});
