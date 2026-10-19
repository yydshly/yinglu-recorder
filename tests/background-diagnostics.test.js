import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectionError, unsupportedPage, validateHandshake } from '../lib/connection.js';
import { recoverStoppedRecording } from '../lib/recovery.js';
import { appendDiagnostic, diagnosticSample } from '../lib/page-diagnostics.js';
import { musicConfig } from '../lib/music-store.js';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = (phase = 'recording') => ({ phase, sample: {
  scope: 'top-document', metric: 'raf-cadence', reason: 'interval', durationMs: 1000,
  visibility: 'visible', visibleMs: 1000, enoughData: true,
  raf: { intervalCount: 59, meanMs: 16, p95Ms: 18, maxMs: 30, over50ms: 0, cadenceHz: 62.5 },
  longTasks: { supported: true, count: 1, totalMs: 80, maxMs: 80 }, webglContextLost: 0
} });

test('标注容量提示只转发录制目标顶层网页，不停止录制或接受其他来源', async t => {
  const h = await harness(t); h.store.recording = { status: 'recording', tabId: 7 };
  const sender = { id: chrome.runtime.id, url: 'https://example.test/project', tab: { id: 7, windowId: 1 }, frameId: 0 };
  const result = await h.request('ANNOTATION_ERROR', { error: '本页笔迹较多' }, sender);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(h.store.recording.status, 'recording');
  assert.equal(h.calls.filter(message => message.type === 'ANNOTATION_ERROR').length, 1);
  assert.equal(h.calls.find(message => message.type === 'ANNOTATION_ERROR').windowId, 1);
  for (const value of [{ ...sender, tab: { id: 8 } }, { ...sender, frameId: 1 }, { ...sender, tab: undefined }])
    assert.equal((await h.request('ANNOTATION_ERROR', { error: '不应转发' }, value)).ok, false);
  assert.equal(h.calls.filter(message => message.type === 'ANNOTATION_ERROR').length, 1);
});

// Run the actual background router and diagnostic normalization. Only external
// persistence/export dependencies are replaced; no DOM or real IndexedDB is used.
async function harness(t, settings = { diagnostics: true }) {
  const store = { targetTab: { id: 7, windowId: 1, title: '作品', url: 'https://example.test/project' } };
  const local = { settings }, calls = [], patches = [], records = new Map();
  let listener;
  const h = { store, local, calls, patches, records, reads: 0 };
  class AutoExporter {
    async restore() {} async queueRecording() {} async tabRemoved() {} async changed() {}
    async tabUpdated() {} async recover() {} async getState() { return { ok: true }; }
  }
  const chrome = {
    runtime: { id: 'diagnostics-test', getURL: path => `chrome-extension://diagnostics-test/${path}`,
      getManifest: () => ({ version: 'test' }), getContexts: async () => [],
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => {
        calls.push(structuredClone(message));
        return message.target === 'offscreen' && message.type === 'STATUS' ? { ok: true, state: structuredClone(store.recording) } : { ok: true };
      } },
    storage: { session: { get: async () => structuredClone(store), set: async data => Object.assign(store, structuredClone(data)) },
      local: { get: async () => structuredClone(local) } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} },
    sidePanel: { open: async () => {} },
    tabs: { get: async id => ({ ...store.targetTab, id }), query: async () => [structuredClone(store.targetTab)],
      sendMessage: async (tabId, message) => {
        calls.push({ tabId, ...structuredClone(message) });
        return { ok: true, width: 1200, height: 800 };
      }, onUpdated: { addListener(fn) { h.updated = fn; } }, onActivated: { addListener() {} }, onRemoved: { addListener() {} } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
    offscreen: { createDocument: async () => {}, closeDocument: async () => {} },
    tabCapture: { getMediaStreamId: async () => 'stream-id' }
  };
  const dependencies = { connectionError, unsupportedPage, validateHandshake, recoverStoppedRecording, appendDiagnostic, diagnosticSample, AutoExporter, musicConfig,
    getRecording: async id => { h.reads++; return structuredClone(records.get(id)); },
    patchRecording: async (id, patch) => {
      patches.push({ id, patch: structuredClone(patch) });
      if (!records.has(id)) return;
      records.set(id, { ...records.get(id), ...structuredClone(patch) });
      return structuredClone(records.get(id));
    } };
  const values = { chrome, backgroundDiagnosticsHarness: dependencies };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(async () => {
    await tick();
    for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const imports = `const { ${Object.keys(dependencies).join(', ')} } = globalThis.backgroundDiagnosticsHarness;\n`;
  await import('data:text/javascript;base64,' + Buffer.from(imports + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random()).toString('base64'));
  h.request = (type, extra = {}, sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }) => new Promise(resolve => {
    listener({ target: 'background', type, ...extra }, sender, resolve);
  });
  h.perf = (sessionId, phase = 'recording', tabId = 7, overrides = {}) => h.request('PERF_SAMPLE', { sessionId, ...sample(phase), ...overrides },
    { id: chrome.runtime.id, url: 'https://example.test/project', tab: { id: tabId }, frameId: 0 });
  h.start = async (diagnostics = true, id = 'video-1') => {
    const response = await h.request('START', { windowId: 1, tabId: 7, options: { range: 'full', diagnostics, autoExport: false } });
    assert.equal(response.ok, true);
    const sessionId = store.recording.sessionId;
    records.set(id, { id, status: 'recording', bytes: 100 });
    await h.request('STATE', { state: { ...store.recording, id, status: 'recording', sequence: 1 } });
    return sessionId;
  };
  h.finish = async () => {
    await h.request('STATE', { state: { ...store.recording, status: 'complete', released: true, sequence: store.recording.sequence + 1 } });
    await tick();
  };
  h.baselines = () => calls.filter(message => message.target === 'overlay' && message.type === 'PERF_BASELINE');
  return h;
}

test('CONNECT 请求短基线，空闲 GET_STATE 重用近期探针并在过期后重新采样', async t => {
  const h = await harness(t);
  assert.equal((await h.request('CONNECT', { windowId: 1 })).ok, true); await tick();
  assert.equal(h.baselines().length, 1);
  assert.equal(h.baselines()[0].tabId, 7); assert.equal(h.baselines()[0].options.sessionId, h.store.pagePerfBaselines[7].sessionId);
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 1);
  h.store.pagePerfBaselines[7].at -= 31000;
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 2);
  assert.notEqual(h.baselines()[0].options.sessionId, h.baselines()[1].options.sessionId);
  assert.equal(h.patches.length, 0); assert.equal(h.reads, 0);
});

test('未设置诊断开关时默认不启动基线或录制采样', async t => {
  const h = await harness(t, {});
  await h.request('CONNECT', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0);
  assert.equal((await h.request('START', { windowId: 1, tabId: 7, options: { range: 'full' } })).ok, true);
  assert.equal(h.store.recording.diagnostics, false);
  assert.equal(h.store.pagePerformance, undefined);
  assert.equal(h.calls.find(call => call.type === 'BEGIN').options.diagnostics, false);
});

test('普通标注不触发性能探针，只有空闲握手成功后 GET_STATE 发起基线', async t => {
  const h = await harness(t);
  await h.request('OVERLAY', { windowId: 1, tabId: 7, command: 'SET', options: { tool: 'rect' } }); await tick();
  assert.equal(h.baselines().length, 0);
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 1);
});

test('关闭诊断设置时 CONNECT 和 GET_STATE 不采样，START false 不建立诊断档案', async t => {
  const h = await harness(t, { diagnostics: false });
  await h.request('CONNECT', { windowId: 1 }); await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0); assert.equal(h.store.pagePerfBaselines, undefined);
  const sessionId = await h.start(false);
  assert.equal(h.store.recording.diagnostics, false); assert.equal(h.store.pagePerformance, undefined);
  assert.equal(h.calls.find(message => message.type === 'BEGIN').options.diagnostics, false);
  assert.equal(h.calls.find(message => message.target === 'offscreen' && message.type === 'START').options.context.diagnostics, false);
  assert.equal((await h.perf(sessionId)).ignored, true);
  await h.finish(); assert.equal(h.patches.length, 0);
});

test('START true 传播诊断开关，采集中 GET_STATE 不新建基线', async t => {
  const h = await harness(t);
  const sessionId = await h.start();
  assert.equal(h.store.pagePerformance[sessionId].tabId, 7);
  assert.equal(h.calls.find(message => message.type === 'BEGIN').options.diagnostics, true);
  assert.equal(h.calls.find(message => message.target === 'offscreen' && message.type === 'START').options.context.diagnostics, true);
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0); assert.equal(h.patches.length, 0);
});

test('PERF_SAMPLE 只接收匹配 session 和标签的有效指标，旧 session 与错标签无效', async t => {
  const h = await harness(t); const sessionId = await h.start();
  assert.equal((await h.perf('stale-session')).ignored, true);
  assert.equal((await h.perf(sessionId, 'recording', 8)).ignored, true);
  assert.equal((await h.perf(sessionId, 'recording', 7, { sample: { scope: 'iframe', metric: 'raf-cadence', visibility: 'visible' } })).ignored, true);
  assert.equal(h.store.pagePerformance[sessionId].samples.length, 0);
  assert.equal((await h.perf(sessionId)).ok, true);
  assert.equal(h.store.pagePerformance[sessionId].samples.length, 1);
  assert.equal(h.store.pagePerformance[sessionId].samples[0].phase, 'recording');
  assert.equal(h.patches.length, 0); assert.equal(h.reads, 0);
});

test('START 复制近期录制前基线，迟到的同一基线也进入当前档案', async t => {
  const h = await harness(t); await h.request('CONNECT', { windowId: 1 }); await tick();
  const baselineId = h.store.pagePerfBaselines[7].sessionId;
  assert.equal((await h.perf(baselineId, 'baseline', 8)).ignored, true);
  await h.perf(baselineId, 'baseline');
  const sessionId = await h.start();
  assert.equal(h.store.pagePerformance[sessionId].samples.length, 1);
  assert.equal(h.store.pagePerformance[sessionId].baselineSessionId, baselineId);
  await h.perf(baselineId, 'baseline');
  assert.equal(h.store.pagePerformance[sessionId].samples.length, 2);
  assert.equal(h.patches.length, 0);
});

test('录制期只写 session storage，终态落库且停止后恢复样本更新同一视频', async t => {
  const h = await harness(t); const sessionId = await h.start();
  await h.perf(sessionId); await h.perf(sessionId);
  assert.equal(h.patches.length, 0); assert.equal(h.reads, 0);
  await h.finish();
  assert.equal(h.store.pagePerformance[sessionId].finished, true);
  assert.equal(h.store.pagePerformance[sessionId].recordingId, 'video-1');
  assert.equal(h.patches.length, 1); assert.equal(h.patches[0].id, 'video-1');
  assert.equal(h.records.get('video-1').pageDiagnostics.samples.length, 2);
  const end = h.calls.find(message => message.type === 'END');
  assert.equal(end.options.sessionId, sessionId); assert.equal(end.options.diagnostics, true);
  await h.perf(sessionId, 'recovery'); await tick();
  assert.equal(h.patches.length, 2);
  assert.equal(h.records.get('video-1').pageDiagnostics.samples.at(-1).phase, 'recovery');
  assert.equal(h.calls.filter(message => message.type === 'PERF_UPDATED' && message.id === 'video-1').length, 2);
});

test('刚结束两秒恢复窗口不自动重启空闲基线', async t => {
  const h = await harness(t); await h.start(); await h.finish();
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0);
});

test('桌面录制活动或全局采集锁存在时，不把额外负载下的节拍当空闲基线', async t => {
  const h = await harness(t);
  h.store.desktopRecording = { status: 'recording', sessionId: 'desktop' };
  await h.request('CONNECT', { windowId: 1 }); await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0);
  h.store.desktopRecording = null; h.store.captureSession = { kind: 'desktop', sessionId: 'desktop', ownerTabId: 20 };
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 0);
  h.store.captureSession = null;
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.equal(h.baselines().length, 1);
});

test('同标签刷新或切换 URL 清理旧文档基线，迟到旧样本不能污染新作品', async t => {
  const h = await harness(t); await h.request('CONNECT', { windowId: 1 }); await tick();
  const first = h.store.pagePerfBaselines[7].sessionId;
  await h.perf(first, 'baseline');
  await h.updated(7, { status: 'loading' }, h.store.targetTab);
  assert.equal(h.store.pagePerfBaselines[7], undefined);
  assert.equal((await h.perf(first, 'baseline')).ignored, true);
  h.store.targetTab.url = 'https://example.test/new-project';
  await h.request('CONNECT', { windowId: 1 }); await tick();
  const second = h.store.pagePerfBaselines[7].sessionId;
  assert.notEqual(second, first); assert.equal(h.store.pagePerfBaselines[7].samples.length, 0);
  await h.updated(7, { url: 'https://example.test/another-project' }, h.store.targetTab);
  assert.equal(h.store.pagePerfBaselines[7], undefined);
  await h.request('GET_STATE', { windowId: 1 }); await tick();
  assert.notEqual(h.store.pagePerfBaselines[7].sessionId, second);
  assert.equal(h.baselines().length, 3);
});
