import test from 'node:test';
import assert from 'node:assert/strict';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 40; i++) { if (predicate()) return; await tick(); }
  throw new Error('Expected connection stage was not reached');
}
async function harness(t, { access = true, ready = [] } = {}) {
  const oldChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = oldChrome; });
  const pending = new Map(); let next = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = ++next; pending.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => pending.delete(id));
  const tabs = new Map([
    [7, { id: 7, windowId: 1, title: 'A', url: 'https://a.example/' }],
    [8, { id: 8, windowId: 1, title: 'B', url: 'https://b.example/' }],
    [20, { id: 20, windowId: 2, title: 'C', url: 'https://c.example/' }]
  ]);
  const active = new Map([[1, 7], [2, 20]]), available = new Set(ready), calls = [], writes = [];
  const store = { targetTab: tabs.get(7) };
  let listener, activated, updated;
  const chrome = globalThis.chrome = {
    runtime: { id: 'connection-test', getURL: p => `chrome-extension://connection-test/${p}`,
      getManifest: () => ({ version: 'test' }), getContexts: async () => [],
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async msg => { calls.push(msg); return { ok: true }; } },
    storage: { session: { get: async () => structuredClone(store), set: async patch => { writes.push(patch); Object.assign(store, structuredClone(patch)); } },
      local: { get: async () => ({}) } },
    permissions: { contains: async () => access },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }, sidePanel: { open: async () => {} },
    tabs: { get: async id => tabs.get(id), query: async query => [tabs.get(active.get(query.windowId ?? 1))],
      sendMessage: async (id, msg) => { calls.push({ ...msg, tabId: id }); return available.has(id) ? { ok: true, width: 1200, height: 800 } : undefined; },
      onActivated: { addListener: fn => { activated = fn; } }, onUpdated: { addListener: fn => { updated = fn; } }, onRemoved: { addListener() {} } },
    scripting: { executeScript: async options => { calls.push({ inject: options.target.tabId }); available.add(options.target.tabId); return [{ frameId: 0, result: { ok: true } }]; } },
    offscreen: { createDocument: async () => calls.push({ offscreen: true }), closeDocument: async () => {} },
    tabCapture: { getMediaStreamId: async () => { calls.push({ capture: true }); return 'stream'; } }
  };
  await import(`../background.js?connection-test=${Math.random()}`);
  const request = (type, extra = {}) => new Promise(resolve => listener({ target: 'background', type, windowId: 1, ...extra },
    { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve));
  return { chrome, store, active, tabs, available, calls, writes, pending, request, activated: info => activated(info), updated: (...args) => updated(...args),
    fire(ms) { const entry = [...pending].find(([, value]) => value.ms === ms); assert.ok(entry, `Missing timeout ${ms}`); pending.delete(entry[0]); entry[1].fn(); } };
}

test('允许自动连接后侧栏跟随当前标签页，仅注入该页且不启动采集或性能探针', async t => {
  const h = await harness(t); h.active.set(1, 8);
  const result = await h.request('GET_STATE', { tabId: 7 });
  assert.equal(result.targetTab.id, 8); assert.equal(result.connected, true); assert.equal(result.autoConnectEnabled, true);
  assert.deepEqual(h.calls.filter(call => call.inject).map(call => call.inject), [8]);
  assert.equal(h.calls.some(call => call.capture || call.offscreen || call.type === 'PERF_BASELINE'), false);
  assert.equal(h.pending.size, 0);
});

test('未授权时自动跟随不弹权限框、不注入，仍识别新网页而不沿用旧连接', async t => {
  const h = await harness(t, { access: false }); h.active.set(1, 8);
  const result = await h.request('GET_STATE');
  assert.equal(result.targetTab.id, 8); assert.equal(result.needsActivation, true); assert.equal(result.connected, false);
  assert.equal(h.calls.some(call => call.inject), false);
});

test('注入被拒绝以 HOST_ACCESS_REQUIRED 标记等待授权，不与连接故障混淆', async t => {
  const h = await harness(t);
  h.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page. Extension manifest must request permission'); };
  const denied = await h.request('CONNECT');
  assert.equal(denied.ok, false); assert.equal(denied.code, 'HOST_ACCESS_REQUIRED');
  assert.equal(h.store.connection.status, 'needs-activation');
  const state = await h.request('GET_STATE');
  assert.equal(state.needsActivation, true);
  assert.equal(state.connection.code, 'HOST_ACCESS_REQUIRED');
});

test('普通注入异常仍是连接错误，不误引导用户授权', async t => {
  const h = await harness(t);
  h.chrome.scripting.executeScript = async () => { throw new Error('script crashed'); };
  const result = await h.request('CONNECT');
  assert.equal(result.ok, false); assert.notEqual(result.code, 'HOST_ACCESS_REQUIRED');
  assert.equal(h.store.connection.status, 'error');
});

test('多个窗口自动连接各自当前网页，重复刷新合并同页脚本注入', async t => {
  const h = await harness(t), injection = deferred();
  h.chrome.scripting.executeScript = async options => {
    const id = options.target.tabId; h.calls.push({ inject: id });
    if (id === 7) await injection.promise;
    h.available.add(id); return [{ frameId: 0, result: { ok: true } }];
  };
  const first = h.request('GET_STATE'), duplicate = h.request('GET_STATE');
  await until(() => h.calls.some(call => call.inject === 7));
  const other = await h.request('GET_STATE', { windowId: 2 });
  assert.equal(other.targetTab.id, 20); assert.equal(other.connected, true);
  injection.resolve();
  assert.equal((await first).targetTab.id, 7); assert.equal((await duplicate).connected, true);
  assert.deepEqual(h.calls.filter(call => call.inject).map(call => call.inject), [7, 20]);
});

test('注入无响应有界退出，不持续自动重试；手动重试可恢复', async t => {
  const h = await harness(t);
  h.chrome.scripting.executeScript = () => { h.calls.push({ inject: 7 }); return new Promise(() => {}); };
  const pending = h.request('GET_STATE');
  await until(() => [...h.pending.values()].some(value => value.ms === 5000)); h.fire(5000);
  const result = await pending;
  assert.equal(result.connected, false); assert.equal(result.connection.status, 'error'); assert.match(result.connection.detail, /加载超时/);
  await h.request('GET_STATE'); assert.equal(h.calls.filter(call => call.inject).length, 1);
  h.chrome.scripting.executeScript = async () => { h.available.add(7); return [{ frameId: 0, result: { ok: true } }]; };
  assert.equal((await h.request('CONNECT')).ok, true); assert.equal(h.store.connection.status, 'connected');
  assert.equal(h.pending.size, 0);
});

test('连接网页 API 卡住也会结束 connecting 状态并释放所有定时器', async t => {
  const h = await harness(t); h.chrome.tabs.get = () => new Promise(() => {});
  const pending = h.request('CONNECT');
  await until(() => [...h.pending.values()].some(value => value.ms === 2000)); h.fire(2000);
  assert.equal((await pending).ok, false); assert.equal(h.store.connection.status, 'error');
  assert.match(h.store.connection.detail, /获取网页超时/); assert.equal(h.pending.size, 0);
});

test('worker 重启遗留的 connecting 可恢复，握手成功则纠正为已连接', async t => {
  for (const ready of [false, true]) {
    const h = await harness(t, { access: false, ready: ready ? [7] : [] });
    h.store.connection = { status: 'connecting', tabId: 7, attemptId: 'old-worker', startedAt: Date.now() };
    const result = await h.request('GET_STATE');
    assert.equal(result.connection.status, ready ? 'connected' : 'error');
    assert.equal(h.store.connection.status, result.connection.status);
  }
});

test('旧网页迟到的连接结果不能覆盖后来连接的新网页', async t => {
  const h = await harness(t), injection = deferred();
  h.chrome.scripting.executeScript = async options => {
    if (options.target.tabId === 7) { h.calls.push({ waiting: true }); await injection.promise; }
    h.available.add(options.target.tabId); return [{ frameId: 0, result: { ok: true } }];
  };
  const old = h.request('CONNECT'); await until(() => h.calls.some(call => call.waiting));
  h.active.set(1, 8); await h.request('CONNECT'); injection.resolve(); await old;
  assert.equal(h.store.connection.tabId, 8); assert.equal(h.store.targetTab.id, 8); assert.equal(h.store.connection.status, 'connected');
});

test('没有侧栏请求时标签切换仅发事件通知，不注入或创建采集；普通导航不空写 storage', async t => {
  const h = await harness(t); h.activated({ tabId: 8, windowId: 1 }); await tick();
  await h.updated(8, { status: 'loading' }, h.tabs.get(8));
  assert.equal(h.calls.some(call => call.inject || call.offscreen || call.capture), false);
  assert.equal(h.writes.length, 0);
});

test('录制进行中切换网页仍锁定原来源，不自动注入新页', async t => {
  const h = await harness(t, { ready: [7] });
  h.store.recording = { status: 'recording', sessionId: 'active', tabId: 7, sourceTab: h.tabs.get(7), sequence: 1 };
  h.chrome.runtime.sendMessage = async msg => msg.target === 'offscreen' ? { ok: true, state: h.store.recording } : { ok: true };
  h.active.set(1, 8);
  const result = await h.request('GET_STATE');
  assert.equal(result.targetTab.id, 7); assert.equal(result.isCurrentTab, false); assert.equal(result.connected, false);
  assert.equal(h.calls.some(call => call.inject), false);
});

test('自动连接不冒充 tabCapture 授权，原生拒绝后用中文说明且释放启动状态', async t => {
  const h = await harness(t, { ready: [7] });
  h.chrome.tabCapture.getMediaStreamId = async () => { throw new Error('Extension has not been invoked for the current page (see activeTab permission).'); };
  const result = await h.request('START', { tabId: 7, options: { range: 'full' } });
  assert.equal(result.ok, false); assert.match(result.error, /网页已连接.*录制权限/);
  assert.match(result.detail, /activeTab/); assert.equal(h.store.recording.status, 'error');
  assert.equal(h.store.captureSession, null);
});

test('活动页网址在 loading 期间就绪时立即通知侧栏，不等待 complete；后台页加载不触发刷新', async t => {
  const h = await harness(t);
  await h.updated(8, { url: 'https://b.example/', status: 'loading' }, { ...h.tabs.get(8), active: true });
  assert.equal(h.calls.some(call => call.target === 'panel' && call.type === 'REFRESH' && call.tabId === 8), true);
  h.calls.length = 0;
  await h.updated(20, { status: 'complete' }, { ...h.tabs.get(20), active: false });
  assert.equal(h.calls.some(call => call.type === 'REFRESH'), false);
});

test('短暂自动连接失败后切走再切回可自动重试，同页普通刷新不会无限重试', async t => {
  const h = await harness(t); let attempts = 0;
  h.chrome.scripting.executeScript = async options => {
    attempts++;
    if (attempts === 1) throw new Error('Frame was removed during navigation');
    h.available.add(options.target.tabId); return [{ frameId: 0, result: { ok: true } }];
  };
  assert.equal((await h.request('GET_STATE')).connected, false);
  await h.request('GET_STATE'); assert.equal(attempts, 1);
  h.active.set(1, 8); h.activated({ windowId: 1, tabId: 8 });
  h.active.set(1, 7); h.activated({ windowId: 1, tabId: 7 });
  assert.equal((await h.request('GET_STATE')).connected, true); assert.equal(attempts, 2);
});

test('加载期连接失败在文档 complete 后自动恢复，不沿用同网址的过期失败', async t => {
  const h = await harness(t); let loading = true;
  h.chrome.scripting.executeScript = async options => {
    if (loading) throw new Error('The frame was removed');
    h.available.add(options.target.tabId); return [{ frameId: 0, result: { ok: true } }];
  };
  assert.equal((await h.request('GET_STATE')).connected, false);
  loading = false; await h.updated(7, { status: 'complete' }, { ...h.tabs.get(7), active: true });
  assert.equal((await h.request('GET_STATE')).connected, true);
});

test('新激活网页尚无地址时显示加载中，不误判为权限缺失', async t => {
  const h = await harness(t); h.active.set(1, 8);
  h.tabs.set(8, { id: 8, windowId: 1, status: 'loading', url: '', pendingUrl: 'https://b.example/' });
  const result = await h.request('GET_STATE');
  assert.equal(result.pageLoading, true); assert.equal(result.needsActivation, false);
  assert.equal(result.connection.status, 'loading');
  assert.equal(h.calls.some(call => call.inject), false);
});

test('complete 到达时隔离旧文档未结束的连接，迟到失败不污染已就绪网页', async t => {
  const h = await harness(t), oldDocument = deferred(); let attempts = 0;
  h.chrome.scripting.executeScript = async options => {
    if (++attempts === 1) { await oldDocument.promise; throw new Error('Old frame disappeared'); }
    h.available.add(options.target.tabId); return [{ frameId: 0, result: { ok: true } }];
  };
  const old = h.request('GET_STATE'); await until(() => attempts === 1);
  await h.updated(7, { status: 'complete' }, { ...h.tabs.get(7), active: true });
  const ready = h.request('GET_STATE'); await tick(); oldDocument.resolve();
  assert.equal((await ready).connected, true); await old;
  assert.equal((await h.request('GET_STATE')).connected, true); assert.equal(attempts, 2);
  assert.equal(h.pending.size, 0);
});
