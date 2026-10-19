import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceUrl = new URL('../background.js', import.meta.url);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await tick(); }
  throw new Error('Expected background operation was not reached');
}

// Exercise the real router, coordinator and recovery helper. The fixture only
// replaces external Chrome, persistence and export-worker operations.
async function harness(t) {
  const store = { targetTab: { id: 7, windowId: 1, title: '演示项目', url: 'https://example.test/' } };
  const records = new Map(['one', 'two'].map(id => [id, { id, status: 'complete', bytes: 128, duration: 2000 }]));
  const calls = [], pages = new Map(), events = {};
  const h = { store, records, calls, pages, events };
  const db = {
    getRecording: async id => structuredClone(records.get(id)),
    patchRecording: async (id, patch) => {
      calls.push({ operation: 'patch', id, patch: structuredClone(patch) });
      if (!records.has(id)) return;
      const record = { ...records.get(id), ...structuredClone(patch) }; records.set(id, record); return structuredClone(record);
    },
    deleteRecording: async id => { calls.push({ operation: 'delete', id }); if (h.deleteGate) await h.deleteGate; records.delete(id); }
  };
  class AutoExporter {
    constructor({ canPrepare = async () => true, onRelease = async () => {} } = {}) {
      h.exporter = this; this.canPrepare = canPrepare; this.onRelease = onRelease;
    }
    async restore() {}
    async queueRecording(id) { return this.retry(id); }
    async retry(id, { format = 'original' } = {}) {
      calls.push({ operation: 'retry', id, format });
      if (h.retryGate) await h.retryGate;
      const job = { recordingId: id, status: 'queued', token: `export-${id}`, format };
      store.autoExportJobs = [...(store.autoExportJobs || []).filter(item => item.recordingId !== id), job];
      await this.pump();
      return { ok: true, export: { status: job.status, format } };
    }
    async pump() {
      if ((store.autoExportJobs || []).some(job => ['preparing', 'downloading'].includes(job.status))) return;
      for (const job of store.autoExportJobs || []) {
        if (job.status !== 'queued' || !await this.canPrepare(job)) continue;
        job.status = 'preparing'; return;
      }
    }
    async finishConversion(id) {
      const job = store.autoExportJobs.find(item => item.recordingId === id);
      job.status = 'downloading'; await this.onRelease(job);
    }
    async recover(id, previous) { calls.push({ operation: 'recover-export', id, previous }); }
    async getState(id) { calls.push({ operation: 'export-state', id }); return { ok: true, export: records.get(id)?.export }; }
    async tabUpdated() {} async tabRemoved() {} async changed() {}
  }
  let listener;
  const chrome = {
    runtime: { id: 'access-test', getURL: path => `chrome-extension://access-test/${path}`,
      getManifest: () => ({ version: 'test' }), getContexts: async filter => filter.contextTypes?.includes('TAB')
        ? [...pages.values()].filter(page => page.documentId && (!filter.tabIds || filter.tabIds.includes(page.id)) &&
          (!filter.documentIds || filter.documentIds.includes(page.documentId)) && (!filter.documentUrls || filter.documentUrls.includes(page.url)))
          .map(page => ({ contextType: 'TAB', documentId: page.documentId, documentUrl: page.url, tabId: page.id })) : [],
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        calls.push(message);
        if (message.target === 'desktop' && message.type === 'STATUS') {
          if (h.desktopStatus) return h.desktopStatus(message);
          return { ok: true, documentToken: `instance-${pages.get(message.tabId)?.documentId}`,
            sessionId: store.captureSession?.sessionId || store.desktopRecording?.sessionId,
            state: store.desktopRecording || { status: 'idle' } };
        }
        return { ok: true };
      } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }, sidePanel: { open: async () => {} },
    storage: { session: { get: async () => structuredClone(store), set: async patch => Object.assign(store, structuredClone(patch)) },
      local: { get: async () => ({ setting_diagnostics: false }), set: async () => {} } },
    tabs: { get: async id => { if (!pages.has(id)) throw new Error('tab closed'); return { ...pages.get(id) }; },
      query: async () => [{ ...store.targetTab }],
      sendMessage: async (id, message) => { calls.push({ tabId: id, ...message }); return { ok: true, width: 1200, height: 800 }; },
      onUpdated: { addListener: fn => { events.updated = fn; } }, onRemoved: { addListener: fn => { events.removed = fn; } },
      onActivated: { addListener() {} } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    tabCapture: { getMediaStreamId: async () => { calls.push({ operation: 'acquire-tab' }); return 'stream'; } }
  };
  pages.set(7, store.targetTab);
  for (const id of [21, 22]) pages.set(id, { id, url: chrome.runtime.getURL('desktop.html'), documentId: `document-${id}` });
  for (const id of [31, 32]) pages.set(id, { id, url: chrome.runtime.getURL('library.html') });
  const previous = { chrome: globalThis.chrome, backgroundAccessFixture: globalThis.backgroundAccessFixture };
  globalThis.chrome = chrome; globalThis.backgroundAccessFixture = { db, AutoExporter };
  t.after(async () => { await tick(); Object.assign(globalThis, previous); });
  let source = await readFile(sourceUrl, 'utf8');
  source = source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/lib\/db\.js['"];?/, 'const {$1} = globalThis.backgroundAccessFixture.db;')
    .replace(/import\s*\{\s*AutoExporter\s*\}\s*from\s*['"]\.\/lib\/auto-export\.js['"];?/, 'const {AutoExporter} = globalThis.backgroundAccessFixture;')
    .replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, sourceUrl).href}${quote}`);
  await import(`data:text/javascript;base64,${Buffer.from(source + '\n//' + Math.random()).toString('base64')}`);
  h.chrome = chrome;
  h.sender = (file = 'library.html', tabId = 31, documentId = `document-${tabId}`) => ({
    id: chrome.runtime.id, url: chrome.runtime.getURL(file), tab: { id: tabId }, documentId
  });
  h.request = (type, data = {}, sender = h.sender()) => new Promise(resolve => {
    listener({ target: 'background', type, ...data }, sender, resolve);
  });
  h.start = () => h.request('START', { tabId: 7, windowId: 1, options: { range: 'full', diagnostics: false, autoExport: false } }, h.sender('panel.html', 7));
  h.acquire = (recordingId = 'one', token = 'reader-one', sender) => h.request('MEDIA_READ_ACQUIRE', { recordingId, token }, sender);
  h.release = (recordingId = 'one', token = 'reader-one', sender) => h.request('MEDIA_READ_RELEASE', { recordingId, token }, sender);
  h.remove = recordingId => h.request('DELETE_RECORDING', { recordingId }, h.sender('library.html', 32));
  return h;
}

test('离屏录制启动失败的尺寸诊断可经后台返回侧栏', async t => {
  const h = await harness(t), send = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.target === 'offscreen' && message.type === 'START'
    ? Promise.resolve({ ok: false, error: '视口与采集画面不匹配', detail: 'viewport=1395x896; frame=1920x1080' }) : send(message);
  const response = await h.start();
  assert.equal(response.ok, false); assert.match(response.error, /不匹配/);
  assert.equal(response.detail, 'viewport=1395x896; frame=1920x1080');
  assert.equal(h.store.recording.detail, response.detail); assert.equal(h.store.recording.released, true);
});

test('另一录制库页面持有读取锁时禁止删除，释放后可删', async t => {
  const h = await harness(t);
  assert.equal((await h.acquire()).ok, true);
  assert.equal((await h.remove('one')).ok, false); assert.equal(h.records.has('one'), true);
  assert.equal((await h.release()).ok, true);
  assert.equal((await h.remove('one')).ok, true); assert.equal(h.records.has('one'), false);
});

test('读取token、记录编号和页面owner必须同时匹配才能续约或释放', async t => {
  const h = await harness(t); await h.acquire();
  const otherDocument = h.sender('library.html', 31, 'reloaded-document');
  for (const data of [{ token: 'wrong-token', recordingId: 'one' }, { token: 'reader-one', recordingId: 'two' }]) {
    assert.equal((await h.request('MEDIA_READ_RENEW', data)).ok, false);
    await h.request('MEDIA_READ_RELEASE', data);
  }
  assert.equal((await h.request('MEDIA_READ_RENEW', { token: 'reader-one', recordingId: 'one' }, otherDocument)).ok, false);
  await h.release('one', 'reader-one', otherDocument);
  assert.equal((await h.remove('one')).ok, false); assert.equal(h.store.mediaReaders.length, 1);
  assert.equal((await h.request('MEDIA_READ_RENEW', { token: 'reader-one', recordingId: 'one' })).ok, true);
  await h.release(); assert.equal((await h.remove('one')).ok, true);
});

test('多个读取页面必须全部释放后才能删除', async t => {
  const h = await harness(t); await h.acquire();
  await h.acquire('one', 'reader-two', h.sender('library.html', 32));
  await h.release(); assert.equal((await h.remove('one')).ok, false);
  await h.release('one', 'reader-two', h.sender('library.html', 32));
  assert.equal((await h.remove('one')).ok, true);
});

test('过期读取锁不再阻止删除，过期token不能续约', async t => {
  const h = await harness(t); await h.acquire();
  h.store.mediaReaders[0].expiresAt = Date.now() - 1;
  assert.equal((await h.request('MEDIA_READ_RENEW', { recordingId: 'one', token: 'reader-one' })).ok, false);
  assert.equal((await h.remove('one')).ok, true);
});

test('读取页面导航后清理该页锁，保留其他页面读取锁', async t => {
  const h = await harness(t); await h.acquire();
  await h.acquire('two', 'reader-two', h.sender('library.html', 32));
  await h.events.updated(31, { status: 'loading' }, { id: 31 });
  assert.equal((await h.remove('one')).ok, true); assert.equal((await h.remove('two')).ok, false);
});

test('关闭读取页面释放其锁', async t => {
  const h = await harness(t); await h.acquire(); h.events.removed(31);
  await until(() => h.store.mediaReaders?.length === 0);
  assert.equal((await h.remove('one')).ok, true);
});

test('录制库读写操作拒绝其他扩展页面和非法凭据', async t => {
  const h = await harness(t);
  assert.equal((await h.acquire('one', 'reader-one', h.sender('panel.html'))).ok, false);
  assert.equal((await h.request('DELETE_RECORDING', { recordingId: 'one' }, h.sender('desktop.html', 21))).ok, false);
  assert.equal((await h.acquire('one', 'short')).ok, false);
  assert.equal(h.records.has('one'), true);
});

test('删除与新读取申请串行：删除事务未完成时不能取得已删除媒体的锁', async t => {
  const h = await harness(t); let release;
  h.deleteGate = new Promise(resolve => { release = resolve; });
  const deleting = h.remove('one'); await until(() => h.calls.some(call => call.operation === 'delete'));
  const reading = h.acquire(); release();
  assert.equal((await deleting).ok, true); assert.equal((await reading).ok, false);
  assert.equal(h.store.mediaReaders?.length || 0, 0);
});

test('无活跃录制的IDB recording记录在读取前恢复为interrupted', async t => {
  const h = await harness(t); h.records.get('one').status = 'recording';
  assert.equal((await h.acquire()).ok, true); assert.equal(h.records.get('one').status, 'interrupted');
  assert.equal(h.records.get('one').bytes, 128); assert.equal(h.records.get('one').duration, 2000);
});

for (const slot of ['recording', 'desktopRecording']) {
  test(`${slot}仍处于saving时拒绝读取、重试和删除，不改库中录制状态`, async t => {
    const h = await harness(t); h.records.get('one').status = 'recording';
    h.store[slot] = { id: 'one', status: 'saving', sessionId: 'live', released: true, ...(slot === 'desktopRecording' ? { ownerTabId: 21 } : {}) };
    assert.equal((await h.acquire()).ok, false);
    assert.equal((await h.request('RETRY_EXPORT', { recordingId: 'one' })).ok, false);
    assert.equal((await h.remove('one')).ok, false);
    assert.equal(h.records.get('one').status, 'recording');
    assert.equal(h.calls.some(call => call.operation === 'retry'), false);
  });
}

test('重试自动导出先恢复陈旧recording记录，再交给导出器', async t => {
  const h = await harness(t); h.records.get('one').status = 'recording';
  const result = await h.request('RETRY_EXPORT', { recordingId: 'one' });
  assert.equal(result.ok, true); assert.equal(h.records.get('one').status, 'interrupted');
  assert.ok(h.calls.findIndex(call => call.operation === 'patch') < h.calls.findIndex(call => call.operation === 'retry'));
  assert.equal((await h.remove('one')).ok, false);
});

test('自动导出任务尚未落盘期间的预留也阻止删除', async t => {
  const h = await harness(t); let release;
  h.retryGate = new Promise(resolve => { release = resolve; });
  const retry = h.request('RETRY_EXPORT', { recordingId: 'one' });
  await until(() => h.calls.some(call => call.operation === 'retry'));
  assert.equal((await h.remove('one')).ok, false);
  release(); assert.equal((await retry).ok, true);
});

test('GET_EXPORT_STATE先根据持久化导出记录恢复，再返回任务状态', async t => {
  const h = await harness(t); h.records.get('one').export = { status: 'downloading', downloadId: 9, format: 'mp4' };
  const result = await h.request('GET_EXPORT_STATE', { recordingId: 'one' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.filter(call => ['recover-export', 'export-state'].includes(call.operation)), [
    { operation: 'recover-export', id: 'one', previous: h.records.get('one').export }, { operation: 'export-state', id: 'one' }
  ]);
});

test('桌面预览持锁时不能开始网页采集，同owner/session可转正式录制', async t => {
  const h = await harness(t), owner = h.sender('desktop.html', 21);
  assert.equal((await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, owner)).ok, true);
  assert.equal((await h.start()).ok, false); assert.equal(h.calls.some(call => call.operation === 'acquire-tab'), false);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'preview' }, owner)).ok, true);
  assert.deepEqual(h.store.captureSession, { kind: 'desktop', sessionId: 'preview', ownerTabId: 21, ownerDocumentId: 'document-21', ownerInstanceId: null });
});

test('其他owner或session不能转移、释放桌面预览锁', async t => {
  const h = await harness(t), owner = h.sender('desktop.html', 21), other = h.sender('desktop.html', 22);
  await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, owner);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'preview' }, other)).ok, false);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'wrong' }, owner)).ok, false);
  await h.request('DESKTOP_PREVIEW_RELEASE', { sessionId: 'preview' }, other);
  await h.request('DESKTOP_PREVIEW_RELEASE', { sessionId: 'wrong' }, owner);
  assert.equal(h.store.captureSession.sessionId, 'preview');
  await h.request('DESKTOP_PREVIEW_RELEASE', { sessionId: 'preview' }, owner);
  assert.equal(h.store.captureSession, null); assert.equal((await h.start()).ok, true);
});

test('预览转正式录制后，迟到预览释放消息不能释放正式录制锁', async t => {
  const h = await harness(t), owner = h.sender('desktop.html', 21);
  await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, owner);
  await h.request('DESKTOP_ACQUIRE', { sessionId: 'preview' }, owner);
  await h.request('DESKTOP_PREVIEW_RELEASE', { sessionId: 'preview' }, owner);
  assert.equal(h.store.captureSession.kind, 'desktop'); assert.equal((await h.start()).ok, false);
});

test('预览页面导航释放预览锁，随后允许网页录制', async t => {
  const h = await harness(t), owner = h.sender('desktop.html', 21);
  await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, owner);
  h.pages.get(21).url = 'https://example.test/away';
  await h.events.updated(21, { url: 'https://example.test/away' }, { id: 21 });
  assert.equal(h.store.captureSession, null); assert.equal((await h.start()).ok, true);
});

for (const lock of ['web', 'desktop-preview']) {
  test(`已有${lock}采集时不启动MP4转换`, async t => {
    const h = await harness(t); h.store.captureSession = { kind: lock, sessionId: 'active', ownerTabId: 21 };
    const result = await h.request('RETRY_EXPORT', { recordingId: 'one', format: 'mp4' });
    assert.equal(result.ok, false); assert.match(result.error, /结束录制和来源预览/);
    assert.equal(h.calls.some(call => call.operation === 'retry'), false);
  });
}

test('MP4正在转换时拒绝网页采集和桌面预览', async t => {
  const h = await harness(t); h.store.autoExportJobs = [{ recordingId: 'one', format: 'mp4', status: 'preparing' }];
  assert.equal((await h.start()).ok, false);
  assert.equal((await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, h.sender('desktop.html', 21))).ok, false);
  assert.equal(h.store.captureSession, undefined);
});

test('排队MP4尚未开始转码时允许采集，实际转码需另行取得锁', async t => {
  const h = await harness(t); h.store.autoExportJobs = [
    { recordingId: 'two', format: 'original', status: 'downloading' },
    { recordingId: 'one', format: 'mp4', status: 'queued' }
  ];
  assert.equal((await h.start()).ok, true);
  assert.equal(h.store.autoExportJobs[1].status, 'queued');
});

test('网页采集先获得锁时，稍晚的MP4只能排队，采集结束后才可准备转换', async t => {
  const h = await harness(t); let release;
  h.retryGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const converting = h.request('RETRY_EXPORT', { recordingId: 'one', format: 'mp4' });
  await until(() => h.calls.some(call => call.operation === 'retry'));
  const starting = await h.start(); release(); await converting;
  assert.equal(starting.ok, true); assert.equal(h.store.autoExportJobs[0].status, 'queued');
  await h.request('STATE', { state: { sessionId: h.store.recording.sessionId, sequence: 1, status: 'cancelled', released: true } }, h.sender('offscreen.html', 7));
  await h.exporter.pump(); assert.equal(h.store.autoExportJobs[0].status, 'preparing');
});

test('桌面来源预览先获得锁时，稍晚的MP4只能排队，释放预览后才可转换', async t => {
  const h = await harness(t); let release;
  h.retryGate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const converting = h.request('RETRY_EXPORT', { recordingId: 'one', format: 'mp4' });
  await until(() => h.calls.some(call => call.operation === 'retry'));
  const preview = await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, h.sender('desktop.html', 21));
  release(); await converting;
  assert.equal(preview.ok, true); assert.equal(h.store.autoExportJobs[0].status, 'queued');
  await h.request('DESKTOP_PREVIEW_RELEASE', { sessionId: 'preview' }, h.sender('desktop.html', 21));
  await h.exporter.pump(); assert.equal(h.store.autoExportJobs[0].status, 'preparing');
});

test('MP4转换先获得准备锁时拒绝网页和桌面采集，编码结束后允许录制', async t => {
  const h = await harness(t);
  assert.equal((await h.request('RETRY_EXPORT', { recordingId: 'one', format: 'mp4' })).ok, true);
  assert.equal(h.store.autoExportJobs[0].status, 'preparing');
  assert.equal((await h.start()).ok, false);
  assert.equal((await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview' }, h.sender('desktop.html', 21))).ok, false);
  await h.exporter.finishConversion('one');
  assert.equal((await h.start()).ok, true);
});

test('MP4申请失败后释放转换预留，不永久阻止下一次录制', async t => {
  const h = await harness(t); let reject;
  h.retryGate = new Promise((resolve, fail) => { reject = fail; });
  const converting = h.request('RETRY_EXPORT', { recordingId: 'one', format: 'mp4' });
  await until(() => h.calls.some(call => call.operation === 'retry'));
  reject(new Error('export failed')); assert.equal((await converting).ok, false);
  assert.equal((await h.start()).ok, true);
});

async function desktopRecording(h, { status = 'recording' } = {}) {
  const sender = h.sender('desktop.html', 21), documentToken = 'instance-document-21', sessionId = 'desktop-old';
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId, documentToken }, sender)).ok, true);
  h.records.get('one').status = 'recording';
  assert.equal((await h.request('DESKTOP_STATE', { documentToken,
    state: { id: 'one', status, sessionId, sequence: 1, autoExport: false, released: status === 'saving' } }, sender)).ok, true);
  return { sender, documentToken, sessionId };
}

test('桌面刷新遗失pagehide消息时恢复IDB片段并释放旧锁，新页面可重新选择', async t => {
  const h = await harness(t); await desktopRecording(h);
  h.pages.get(21).documentId = 'document-new';
  await h.events.updated(21, { status: 'loading' }, h.pages.get(21));
  assert.equal(h.store.captureSession, null); assert.equal(h.store.desktopRecording.status, 'interrupted');
  assert.equal(h.store.desktopRecording.aborted, true); assert.equal(h.records.get('one').status, 'interrupted');
  assert.equal(h.records.get('one').bytes, 128); assert.equal(h.records.get('one').duration, 2000);
  assert.equal((await h.acquire('one')).ok, true);
  assert.equal((await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'new-preview', documentToken: 'instance-document-new' },
    h.sender('desktop.html', 21, 'document-new'))).ok, true);
});

test('未收到导航事件时新文档READY仍恢复旧录制，旧文档状态及释放不污染新会话', async t => {
  const h = await harness(t), old = await desktopRecording(h);
  h.pages.get(21).documentId = 'document-new';
  const current = h.sender('desktop.html', 21, 'document-new'), documentToken = 'instance-document-new';
  const ready = await h.request('DESKTOP_READY', { documentToken }, current);
  assert.equal(ready.recovered.id, 'one'); assert.equal(ready.recovered.status, 'interrupted');
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'new', documentToken }, current)).ok, true);
  for (const [type, data] of [
    ['DESKTOP_STATE', { state: { sessionId: 'new', sequence: 999, status: 'complete', id: 'bad' } }],
    ['DESKTOP_RELEASE', { sessionId: 'new' }], ['DESKTOP_READY', {}], ['DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'old-late' }]
  ]) {
    assert.equal((await h.request(type, { ...data, documentToken: old.documentToken }, old.sender)).ok, false);
    assert.equal(h.store.captureSession.sessionId, 'new'); assert.notEqual(h.store.desktopRecording.id, 'bad');
  }
});

test('桌面渲染进程消失但标签和URL仍在时，下一次网页开始恢复旧锁', async t => {
  const h = await harness(t); await desktopRecording(h);
  delete h.pages.get(21).documentId;
  assert.equal((await h.start()).ok, true);
  assert.equal(h.store.captureSession.kind, 'web'); assert.equal(h.records.get('one').status, 'interrupted');
});

test('桌面窗口在saving时关闭，已完整落盘的文件保留complete', async t => {
  const h = await harness(t); await desktopRecording(h, { status: 'saving' });
  h.records.get('one').status = 'complete'; h.pages.delete(21); h.events.removed(21);
  await until(() => h.store.captureSession === null);
  assert.equal(h.store.desktopRecording.status, 'complete'); assert.equal(h.store.desktopRecording.error, null);
  assert.equal(h.records.get('one').status, 'complete'); assert.equal((await h.acquire('one')).ok, true);
});

test('同文档保存期间即使已释放来源也不提前开放读取', async t => {
  const h = await harness(t); await desktopRecording(h, { status: 'saving' });
  assert.equal((await h.acquire('one')).ok, false); assert.equal(h.records.get('one').status, 'recording');
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).ids, ['one']);
  assert.equal(h.store.captureSession.sessionId, 'desktop-old');
});

test('迟到的导航事件不能终结已绑定新文档的预览', async t => {
  const h = await harness(t), current = h.sender('desktop.html', 21);
  await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'new-preview', documentToken: 'instance-document-21' }, current);
  await h.events.updated(21, { status: 'loading', url: 'https://old-navigation.test/' }, h.pages.get(21));
  assert.equal(h.store.captureSession.sessionId, 'new-preview');
});

test('上一段complete状态不会让同页新预览或准备会话被误恢复', async t => {
  const h = await harness(t), sender = h.sender('desktop.html', 21), documentToken = 'instance-document-21';
  h.store.desktopRecording = { status: 'complete', sessionId: 'previous', id: 'one', ownerTabId: 21 };
  await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'new-preview', documentToken }, sender);
  assert.equal((await h.start()).ok, false); assert.equal(h.store.captureSession.sessionId, 'new-preview');
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'new-preview', documentToken }, sender)).ok, true);
  assert.equal((await h.start()).ok, false); assert.equal(h.store.captureSession.kind, 'desktop');
});

test('没有Chrome documentId时通过STATUS校验文档token，旧token不能冒充新页面', async t => {
  const h = await harness(t), sender = { ...h.sender('desktop.html', 21), documentId: undefined };
  const documentToken = 'instance-document-21';
  assert.equal((await h.request('DESKTOP_PREVIEW_ACQUIRE', { sessionId: 'preview', documentToken }, sender)).ok, true);
  assert.equal((await h.request('DESKTOP_READY', { documentToken: 'old-token' }, sender)).ok, false);
  assert.equal(h.store.captureSession.sessionId, 'preview');
});

test('旧版本仅按标签绑定的录制可由新文档STATUS确认已结束并恢复', async t => {
  const h = await harness(t);
  h.store.captureSession = { kind: 'desktop', ownerTabId: 21, sessionId: 'legacy' };
  h.store.desktopRecording = { status: 'recording', ownerTabId: 21, sessionId: 'legacy', id: 'one', autoExport: false };
  h.records.get('one').status = 'recording';
  h.desktopStatus = async () => ({ ok: true, documentToken: 'new-instance', state: { status: 'idle' } });
  const result = await h.request('DESKTOP_READY', { documentToken: 'new-instance' }, h.sender('desktop.html', 21));
  assert.equal(result.recovered.status, 'interrupted'); assert.equal(h.store.captureSession, null);
});

test('清理未完成的终态导出仍保护原视频，并且旧token释放不能删除新转换锁', async t => {
  const h = await harness(t);
  h.store.autoExportJobs = [{ recordingId: 'one', status: 'error', cleanupPending: true }];
  assert.equal((await h.remove('one')).ok, false);
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, ['one']);
  h.store.captureSession = { kind: 'conversion', sessionId: 'new-token', recordingId: 'one' };
  await h.exporter.onRelease({ recordingId: 'one', token: 'old-token' });
  assert.equal(h.store.captureSession.sessionId, 'new-token');
  await h.exporter.onRelease({ recordingId: 'one', token: 'new-token' }); assert.equal(h.store.captureSession, null);
});

test('旧READY的文档检查迟到时不能在新READY和acquire之后释放新会话', async t => {
  const h = await harness(t), old = await desktopRecording(h);
  const getContexts = h.chrome.runtime.getContexts;
  let releaseOld, entered = false;
  h.chrome.runtime.getContexts = async filter => {
    const snapshot = await getContexts(filter);
    if (!entered && filter.documentIds?.includes('document-21')) {
      entered = true; await new Promise(resolve => { releaseOld = resolve; });
    }
    return snapshot;
  };
  const oldReady = h.request('DESKTOP_READY', { documentToken: old.documentToken }, old.sender);
  await until(() => entered); h.pages.get(21).documentId = 'document-new';
  const current = h.sender('desktop.html', 21, 'document-new'), documentToken = 'instance-document-new';
  const ready = h.request('DESKTOP_READY', { documentToken }, current);
  const acquiring = h.request('DESKTOP_ACQUIRE', { sessionId: 'new-live', documentToken }, current);
  await tick(); releaseOld(); await oldReady;
  assert.equal((await ready).ok, true); assert.equal((await acquiring).ok, true);
  assert.equal(h.store.captureSession.sessionId, 'new-live'); assert.equal(h.store.captureSession.ownerDocumentId, 'document-new');
});

test('当前文档仍存在但STATUS超时，不把慢响应误判为采集已结束', async t => {
  const h = await harness(t); await desktopRecording(h);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => schedule(callback, delay === 1500 ? 0 : delay, ...args));
  h.desktopStatus = () => new Promise(() => {});
  assert.equal((await h.start()).ok, false);
  assert.equal(h.store.captureSession.sessionId, 'desktop-old'); assert.equal(h.store.desktopRecording.status, 'recording');
  assert.equal(h.records.get('one').status, 'recording');
});
