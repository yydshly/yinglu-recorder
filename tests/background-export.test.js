import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectionError, unsupportedPage, validateHandshake } from '../lib/connection.js';
import { recoverStoppedRecording } from '../lib/recovery.js';
import { AutoExporter } from '../lib/auto-export.js';
import { appendDiagnostic, diagnosticSample } from '../lib/page-diagnostics.js';
import { musicConfig } from '../lib/music-store.js';
const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); } throw new Error('后台导出任务没有推进'); };

async function harness(t, { downloads = true, exportJobs = [], downloadItems = [] } = {}) {
  const h = { store: { targetTab: { id: 7, title: '演示网页', url: 'https://example.test/', windowId: 1 }, autoExportJobs: structuredClone(exportJobs) }, durable: { autoExportJobs: structuredClone(exportJobs), setting_diagnostics: false }, calls: [], created: [], downloads: structuredClone(downloadItems), closed: [], records: new Map(), pages: new Map(), alarms: new Map(), nextTab: 30, finishGate: undefined };
  let listener, changed, removed;
  h.pages.set(7, h.store.targetTab); h.pages.set(21, { id: 21, url: 'chrome-extension://test-extension/desktop.html' });
  for (const job of exportJobs) {
    h.records.set(job.recordingId, { id: job.recordingId, status: 'complete', bytes: 128, source: ['saved chunk'] });
    if (Number.isInteger(job.tabId)) h.pages.set(job.tabId, { id: job.tabId,
      url: `chrome-extension://test-extension/exporter.html?id=${job.recordingId}&token=${job.token}&format=${job.format || 'original'}` });
  }
  const getRecording = async id => structuredClone(h.records.get(id));
  const patchRecording = async (id, patch) => {
    const record = h.records.get(id); if (!record) return;
    const updated = { ...record, ...structuredClone(patch) }; h.records.set(id, updated); return updated;
  };
  const chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, getManifest: () => ({ version: '0.3.0' }), getContexts: async () => [],
      onMessage: { addListener: fn => listener = fn }, sendMessage: async message => {
        h.calls.push(message);
        if (message.target === 'exporter' && h.finishGate) return h.finishGate;
        return { ok: true };
      } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }, sidePanel: { open: async () => {} },
    storage: { session: { get: async () => structuredClone(h.store), set: async data => { await h.sessionSet?.(data); Object.assign(h.store, structuredClone(data)); } },
      local: { get: async () => structuredClone(h.durable), set: async data => { await h.localSet?.(data); Object.assign(h.durable, structuredClone(data)); } } },
    alarms: { create: async (name, options) => h.alarms.set(name, options), clear: async name => h.alarms.delete(name), onAlarm: { addListener() {} } },
    tabs: { get: async id => { const page = h.pages.get(id); if (!page) throw new Error('closed'); return page; },
      query: async query => query.active ? [h.store.targetTab] : [...h.pages.values()],
      create: async options => { const page = { id: ++h.nextTab, ...options }; h.created.push(page); h.pages.set(page.id, page); return page; },
      remove: async id => { h.closed.push(id); h.pages.delete(id); },
      sendMessage: async (id, message) => { h.calls.push({ ...message, tabId: id }); return { ok: true, width: 1200, height: 800 }; },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener: fn => removed = fn } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} }, tabCapture: { getMediaStreamId: async () => 'source' }
  };
  if (downloads) chrome.downloads = {
    onChanged: { addListener: fn => changed = fn },
    download: async options => { const id = h.downloads.length + 1; h.downloads.push({ id, ...options, state: 'in_progress', byExtensionId: chrome.runtime.id }); return id; },
    search: async query => h.downloads.filter(item => query.id !== undefined ? item.id === query.id : item.url === query.url),
    cancel: async id => { const item = h.downloads.find(item => item.id === id); if (item) item.state = 'interrupted'; }
  };
  h.chrome = chrome;
  class TestAutoExporter extends AutoExporter {
    constructor(options) { super({ ...options, storageTimeoutMs: 10 }); h.exporter = this; }
  }
  const deleteRecording = async id => { h.records.delete(id); };
  const injection = { connectionError, unsupportedPage, validateHandshake, getRecording, patchRecording, deleteRecording,
    recoverStoppedRecording, AutoExporter: TestAutoExporter, appendDiagnostic, diagnosticSample, musicConfig };
  const savedChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome'), savedInjection = Object.getOwnPropertyDescriptor(globalThis, 'backgroundExportTest');
  Object.defineProperty(globalThis, 'chrome', { value: chrome, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'backgroundExportTest', { value: injection, configurable: true, writable: true });
  t.after(async () => {
    for (let i = 0; i < 5; i++) await tick();
    savedChrome ? Object.defineProperty(globalThis, 'chrome', savedChrome) : delete globalThis.chrome;
    savedInjection ? Object.defineProperty(globalThis, 'backgroundExportTest', savedInjection) : delete globalThis.backgroundExportTest;
  });
  const code = 'const { connectionError,unsupportedPage,validateHandshake,getRecording,patchRecording,deleteRecording,recoverStoppedRecording,AutoExporter,appendDiagnostic,diagnosticSample,musicConfig }=globalThis.backgroundExportTest;\n' + background.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')); await tick();
  h.request = (type, data = {}, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }) => new Promise(resolve => {
    listener({ target: 'background', type, ...data }, sender, resolve);
  });
  h.start = async options => {
    assert.equal((await h.request('START', { tabId: 7, windowId: 1, options: { range: 'full', diagnostics: false, ...options } })).ok, true);
    return h.store.recording.sessionId;
  };
  h.finish = async (id, patch = {}) => {
    h.records.set(id, { id, status: patch.status || 'complete', bytes: 128, title: '成片', source: ['saved chunk'] });
    return h.request('STATE', { state: { id, sessionId: h.store.recording.sessionId, sequence: 3, status: 'complete', released: true, ...patch } }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') });
  };
  h.job = id => h.store.autoExportJobs?.find(job => job.recordingId === id);
  h.export = (id, format = 'original') => h.request('RETRY_EXPORT', { recordingId: id, format },
    { id: chrome.runtime.id, url: chrome.runtime.getURL('library.html') });
  h.ready = (id, overrides = {}, senderOverride = {}) => {
    const job = h.job(id);
    return h.request('EXPORT_READY', { recordingId: id, token: job.token, tabId: job.tabId, url: `blob:chrome-extension://test-extension/${id}`, filename: `录制-${id}.webm`, storage: 'opfs', ...overrides },
      { id: chrome.runtime.id, url: h.pages.get(job.tabId).url, ...senderOverride });
  };
  h.changed = delta => changed(delta); h.removed = id => { h.pages.delete(id); removed(id); };
  return h;
}

test('网页结束只保留回看副本，用户主动导出后广播状态并保护准备和下载中的记录', async t => {
  const h = await harness(t); await h.start(); await h.finish('r1');
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.job('r1'), undefined);
  assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
  assert.equal((await h.export('r1')).ok, true);
  await until(() => Number.isInteger(h.job('r1')?.tabId));
  assert.equal(h.created.length, 1); assert.equal(h.created[0].active, false);
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, ['r1']);
  assert.equal(h.records.get('r1').export.status, 'preparing');
  assert.equal(h.calls.some(message => message.type === 'EXPORT_STATE' && message.recordingId === 'r1'), true);
  assert.equal((await h.ready('r1')).ok, true); assert.equal(h.records.get('r1').export.status, 'downloading');
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, ['r1']);
  assert.equal(h.closed.length, 0); assert.equal(h.downloads[0].saveAs, false);
  h.downloads[0].state = 'complete'; h.changed({ id: 1, state: { current: 'complete' } });
  await until(() => h.closed.length === 1);
  assert.equal(h.records.get('r1').export.status, 'complete'); assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, []);
});

test('旧自动导出设置不再传入录制器，所有网页终态都不会创建导出或下载', async t => {
  const h = await harness(t);
  for (const [index, status] of ['complete', 'interrupted', 'error', 'cancelled'].entries()) {
    await h.start({ autoExport: true });
    const start = h.calls.filter(message => message.target === 'offscreen' && message.type === 'START').at(-1);
    assert.equal(Object.hasOwn(start.options, 'autoExport'), false);
    assert.equal(Object.hasOwn(start.options.context, 'autoExport'), false);
    assert.equal(Object.hasOwn(h.store.recording, 'autoExport'), false);
    await h.finish(`r${index}`, { status, autoExport: true });
    assert.equal(Object.hasOwn(h.store.recording, 'autoExport'), false);
  }
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.deepEqual(h.store.autoExportJobs || [], []);
});

test('桌面完成、中断和取消都不自动导出，旧设置为true也不触发下载', async t => {
  const h = await harness(t), desktop = { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('desktop.html'), tab: { id: 21 } };
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'desktop1' }, desktop)).ok, true);
  h.records.set('desktop-file', { id: 'desktop-file', status: 'interrupted', source: ['saved chunk'] });
  await h.request('DESKTOP_STATE', { state: { sessionId: 'desktop1', sequence: 1, status: 'interrupted', id: 'desktop-file', autoExport: true } }, desktop);
  assert.equal(h.store.captureSession, null); assert.equal(Object.hasOwn(h.store.desktopRecording, 'autoExport'), false);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'desktop2' }, desktop)).ok, true);
  await h.request('DESKTOP_STATE', { state: { sessionId: 'desktop2', sequence: 1, status: 'complete', id: 'disabled', autoExport: false } }, desktop);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'desktop3' }, desktop)).ok, true);
  await h.request('DESKTOP_STATE', { state: { sessionId: 'desktop3', sequence: 1, status: 'cancelled', id: 'cancelled' } }, desktop);
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(h.store.autoExportJobs || [], []); assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0);
  assert.deepEqual(h.records.get('desktop-file').source, ['saved chunk']);
});

test('旧会话完成和重复终态不会创建导出任务，后续网页可以继续录制', async t => {
  const h = await harness(t); const first = await h.start(); await h.finish('r1');
  await h.request('STATE', { state: { sessionId: first, sequence: 3, status: 'complete', id: 'r1' } });
  const second = await h.start(); assert.notEqual(second, first);
  await h.request('STATE', { state: { sessionId: first, sequence: 99, status: 'complete', id: 'old' } });
  assert.equal(h.store.recording.sessionId, second);
  await h.finish('r2'); for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(h.store.autoExportJobs || [], []); assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0);
});

test('强制停止与录制器断开恢复只保留片段，不因旧设置触发导出', async t => {
  const h = await harness(t);
  for (const operation of ['FORCE_STOP', 'GET_STATE']) {
    const sessionId = await h.start({ autoExport: true });
    const id = `recovered-${operation}`;
    Object.assign(h.store.recording, { id, status: 'recording', autoExport: true });
    h.records.set(id, { id, status: 'recording', bytes: 128, duration: 1000, source: ['saved chunk'] });
    assert.equal((await h.request(operation, { sessionId })).ok, true);
    assert.equal(h.store.recording.status, 'interrupted');
    assert.equal(h.records.get(id).status, 'interrupted'); assert.deepEqual(h.records.get(id).source, ['saved chunk']);
    assert.equal(Object.hasOwn(h.store.recording, 'autoExport'), false);
  }
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.deepEqual(h.store.autoExportJobs || [], []);
});

test('桌面录制页面关闭后的异常恢复不自动下载，仍可主动导出恢复片段', async t => {
  const h = await harness(t), desktop = { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('desktop.html'), tab: { id: 21 } };
  await h.request('DESKTOP_ACQUIRE', { sessionId: 'desktop-recovery' }, desktop);
  h.records.set('desktop-file', { id: 'desktop-file', status: 'recording', bytes: 128, duration: 1000, source: ['saved chunk'] });
  await h.request('DESKTOP_STATE', { state: { sessionId: 'desktop-recovery', sequence: 1, status: 'recording', id: 'desktop-file', autoExport: true } }, desktop);
  h.removed(21); await until(() => h.store.desktopRecording.status === 'interrupted');
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0); assert.equal(h.job('desktop-file'), undefined);
  assert.equal((await h.export('desktop-file')).ok, true); assert.equal(h.job('desktop-file').status, 'preparing');
});

test('声明下载权限，API缺失时给出明确导出错误并保留录制副本', async t => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.permissions.includes('downloads'), true);
  const h = await harness(t, { downloads: false }); await h.start(); await h.finish('r1');
  assert.equal(h.job('r1'), undefined); assert.equal(h.records.get('r1').export, undefined);
  await h.export('r1');
  await until(() => h.job('r1')?.status === 'error');
  assert.match(h.records.get('r1').export.error, /下载权限/); assert.deepEqual(h.records.get('r1').source, ['saved chunk']); assert.equal(h.created.length, 0);
});

test('后台路由拒绝普通网页伪装导出页，合法扩展页仍须匹配 token 和来源 URL', async t => {
  const h = await harness(t); await h.start(); await h.finish('r1'); await h.export('r1'); await until(() => Number.isInteger(h.job('r1')?.tabId));
  assert.equal((await h.ready('r1', {}, { url: 'https://example.test/', tab: { id: 7 } })).ok, false);
  assert.equal((await h.ready('r1', { token: 'old' })).ok, false);
  assert.equal((await h.ready('r1', { url: 'blob:https://example.test/file' })).ok, false);
  assert.equal((await h.ready('r1', { filename: '../unsafe.webm' })).ok, false);
  assert.equal(h.downloads.length, 0);
  assert.equal((await h.ready('r1')).ok, true); assert.equal(h.downloads.length, 1);
});

test('手动下载清理尚未回复时，不阻塞网页录制状态协调器', { timeout: 2000 }, async t => {
  const h = await harness(t); await h.start(); await h.finish('r1'); await h.export('r1'); await until(() => Number.isInteger(h.job('r1')?.tabId)); await h.ready('r1');
  let release; h.finishGate = new Promise(resolve => { release = resolve; }); t.after(() => release({ ok: true }));
  h.changed({ id: 1, state: { current: 'complete' } }); await until(() => h.calls.some(message => message.type === 'EXPORT_FINISH'));
  const sessionId = await h.start({ autoExport: false });
  assert.equal((await h.request('STATE', { state: { sessionId, sequence: 1, status: 'recording' } })).ok, true);
  assert.equal(h.store.recording.status, 'recording');
  release({ ok: true }); await until(() => h.closed.length === 1);
});

test('用户主动请求MP4转换仍创建转换页并可下载，原始录制副本保留', async t => {
  const h = await harness(t); await h.start(); await h.finish('r1');
  assert.equal(h.created.length, 0);
  assert.equal((await h.export('r1', 'mp4')).ok, true);
  assert.equal(h.job('r1').format, 'mp4'); assert.match(h.created[0].url, /format=mp4/);
  assert.equal(h.store.captureSession.kind, 'conversion');
  assert.equal((await h.ready('r1', { filename: '成片.mp4' })).ok, true);
  assert.equal(h.downloads.length, 1); assert.equal(h.downloads[0].filename, '映录/成片.mp4');
  assert.equal(h.store.captureSession, null); assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
});

test('重启仍恢复用户已提交的导出下载，不撤销或重复提交既有任务', async t => {
  const h = await harness(t, {
    exportJobs: [{ recordingId: 'manual', token: 'manual-token', status: 'downloading', tabId: 41, downloadId: 88,
      resourceUrl: 'blob:chrome-extension://test-extension/manual', format: 'original' }],
    downloadItems: [{ id: 88, state: 'in_progress', byExtensionId: 'test-extension', url: 'blob:chrome-extension://test-extension/manual' }]
  });
  await until(() => h.records.get('manual')?.export?.status === 'downloading');
  assert.equal(h.created.length, 0); assert.equal(h.closed.length, 0); assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].state, 'in_progress');
  h.downloads[0].state = 'complete'; h.changed({ id: 88, state: { current: 'complete' } });
  await until(() => h.closed.length === 1);
  assert.equal(h.records.get('manual').export.status, 'complete'); assert.deepEqual(h.records.get('manual').source, ['saved chunk']);
});

test('旧版排队任务在启动和打开录制库时均暂停，用户重新选择后才准备导出', async t => {
  const h = await harness(t, { exportJobs: [{ recordingId: 'legacy', token: 'legacy-token', status: 'queued', format: 'original' }] });
  await until(() => h.records.get('legacy').export?.status === 'error');
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0);
  assert.equal((await h.request('GET_EXPORT_STATE', { recordingId: 'legacy' })).export.status, 'error');
  assert.equal(h.created.length, 0); assert.equal(h.downloads.length, 0);
  assert.equal((await h.export('legacy')).ok, true); assert.equal(h.job('legacy').source, 'manual');
  assert.equal(h.created.length, 1); assert.deepEqual(h.records.get('legacy').source, ['saved chunk']);
});

test('持久化失败仍收尾释放真实转换锁，不遗留阻止下一次录制的镜像状态', async t => {
  const h = await harness(t); await h.start(); await h.finish('r1');
  h.sessionSet = async data => { if (data.autoExportJobs) throw new Error('session mirror unavailable'); };
  const exported = await h.export('r1', 'mp4');
  assert.equal(exported.export.status, 'error'); assert.match(exported.export.error, /无法保存/);
  assert.equal(h.store.captureSession, null); assert.equal(h.created.length, 0);
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, []);
  assert.equal((await h.request('START', { tabId: 7, windowId: 1, options: { range: 'full', diagnostics: false } })).ok, true);
  assert.deepEqual(h.records.get('r1').source, ['saved chunk']);
});

test('实际下载后session镜像失败不取消下载，内存任务继续保护源片段并保留健康检查', async t => {
  const h = await harness(t); await h.start(); await h.finish('r1'); await h.export('r1', 'mp4');
  h.sessionSet = async data => {
    if (data.autoExportJobs?.some(job => job.status === 'downloading' || job.status === 'complete')) throw new Error('session mirror unavailable');
  };
  assert.equal((await h.ready('r1', { filename: 'r1.mp4' })).ok, true);
  assert.equal(h.downloads[0].state, 'in_progress'); assert.equal(h.store.captureSession, null);
  // Simulate the session mirror losing this job while the controller and
  // browser download remain alive; durable state still contains its receipt.
  h.store.autoExportJobs = [];
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, ['r1']);
  assert.equal((await h.request('DELETE_RECORDING', { recordingId: 'r1' }, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('library.html') })).ok, false);
  assert.equal(h.records.has('r1'), true); assert.equal(h.alarms.has('export-health'), true);
  h.downloads[0].state = 'complete'; h.changed({ id: 1, state: { current: 'complete' } });
  await until(() => h.closed.length === 1);
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, []);
  assert.equal(h.alarms.has('export-health'), false);
  assert.equal((await h.request('DELETE_RECORDING', { recordingId: 'r1' }, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('library.html') })).ok, true);
  assert.equal(h.records.has('r1'), false);
});

test('终态关闭导出页尚未完成时仍保护原片段，完成清理后解除保护', { timeout: 2000 }, async t => {
  const h = await harness(t); await h.start(); await h.finish('r1'); await h.export('r1', 'mp4');
  let finish; h.finishGate = new Promise(resolve => { finish = resolve; }); t.after(() => finish({ ok: true }));
  const cancelling = h.request('EXPORT_CANCEL', { recordingId: 'r1' });
  await until(() => h.calls.some(message => message.type === 'EXPORT_FINISH'));
  h.store.autoExportJobs = [];
  assert.equal(h.store.captureSession.kind, 'conversion');
  assert.equal((await h.request('DELETE_RECORDING', { recordingId: 'r1' }, { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('library.html') })).ok, false);
  assert.equal((await h.request('GET_ACTIVE_RECORDINGS')).exportIds.includes('r1'), true);
  finish({ ok: true }); await cancelling;
  assert.equal(h.store.captureSession, null); assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).exportIds, []);
});
