import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) { if (predicate()) return; await tick(); }
  throw new Error('Expected async operation was not reached');
}
function timers(t) {
  const pending = new Map(); let next = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    const timer = { id: ++next, unref() {} }; pending.set(timer, { callback, ms }); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => pending.delete(timer));
  return {
    pending, has: ms => [...pending.values()].some(timer => timer.ms === ms),
    get: ms => [...pending.values()].find(timer => timer.ms === ms)?.callback,
    fire(ms) {
      const entry = [...pending.entries()].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected pending timeout ${ms}`);
      pending.delete(entry[0]); entry[1].callback();
    }
  };
}
async function harness(t, { recordStatus = 'recording', contexts = true } = {}) {
  const previous = { chrome: globalThis.chrome, backgroundFlowFixture: globalThis.backgroundFlowFixture };
  t.after(() => Object.assign(globalThis, previous));
  const time = timers(t), calls = [];
  const store = { targetTab: { id: 7, title: '演示项目', url: 'https://example.test/' },
    recording: { status: 'recording', tabId: 7, sessionId: 'session', id: 'video', sequence: 5, autoExport: false },
    captureSession: { kind: 'web', sessionId: 'session', ownerTabId: 7 } };
  const records = new Map([['video', { id: 'video', status: recordStatus, bytes: 4321, duration: 2500 }]]);
  const db = {
    getRecording: async id => { calls.push({ dbGet: id }); return structuredClone(await records.get(id)); },
    patchRecording: async (id, patch) => { calls.push({ dbPatch: id, patch }); const value = { ...records.get(id), ...patch }; records.set(id, value); return value; }
  };
  globalThis.backgroundFlowFixture = { db };
  let listener, contextExists = contexts;
  const chrome = globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({ version: 'test' }),
      getContexts: async () => contextExists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [],
      onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async message => { calls.push(message); return { ok: true }; } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} },
    sidePanel: { open: async () => {} },
    storage: {
      session: { get: async () => structuredClone(store), set: async patch => Object.assign(store, patch) },
      local: { get: async () => ({}), set: async () => {} }
    },
    tabs: { get: async id => ({ ...store.targetTab, id }), query: async () => [{ ...store.targetTab }],
      sendMessage: async (id, message) => { calls.push({ id, ...message }); return { ok: true, width: 1200, height: 800 }; },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener() {} } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
    offscreen: {
      createDocument: async () => { contextExists = true; },
      closeDocument: async () => { calls.push({ closedOffscreen: true }); contextExists = false; }
    },
    tabCapture: { getMediaStreamId: async () => 'stream' },
    downloads: { download: async () => 1, onChanged: { addListener() {} } }
  };
  const moduleUrl = new URL('../background.js', import.meta.url);
  let source = await readFile(moduleUrl, 'utf8');
  source = source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\/lib\/db\.js['"];?/, 'const {$1} = globalThis.backgroundFlowFixture.db;');
  source = source.replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, moduleUrl).href}${quote}`);
  await import(`data:text/javascript;base64,${Buffer.from(source + '\n//' + Math.random()).toString('base64')}`);
  const request = (type, extra = {}) => new Promise(resolve => {
    listener({ target: 'background', type, ...extra }, { id: chrome.runtime.id, url: chrome.runtime.getURL('panel.html') }, resolve);
  });
  return { time, calls, store, records, db, chrome, request, contextExists: () => contextExists };
}

test('强制停止先关闭离屏采集，再恢复已保存片段并释放会话', async t => {
  const h = await harness(t);
  const result = await h.request('FORCE_STOP', { sessionId: 'session' });
  assert.equal(result.forced, true); assert.equal(h.contextExists(), false);
  assert.equal(h.store.recording.status, 'interrupted'); assert.equal(h.store.recording.bytes, 4321);
  assert.equal(h.store.recording.duration, 2500); assert.equal(h.store.recording.released, true);
  assert.equal(h.store.recording.aborted, true); assert.equal(h.store.captureSession, null);
  assert.equal(h.records.get('video').status, 'interrupted');
  assert.ok(h.calls.findIndex(call => call.closedOffscreen) < h.calls.findIndex(call => call.dbGet));
  assert.ok(h.calls.some(call => call.target === 'overlay' && call.type === 'END'));
});

test('停止回执超时也会强制释放，不继续等待失去响应的录制器', async t => {
  const h = await harness(t); const send = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = message => message.target === 'offscreen' && message.type === 'STOP' ? new Promise(() => {}) : send(message);
  const pending = h.request('STOP', { sessionId: 'session' });
  await until(() => h.time.has(3000)); h.time.fire(3000);
  assert.equal((await pending).forced, true); assert.equal(h.contextExists(), false);
  assert.equal(h.store.recording.status, 'interrupted'); assert.equal(h.store.captureSession, null);
});

test('收到STOP回执但一直没有释放状态时，后台看门狗强制收尾', async t => {
  const h = await harness(t);
  assert.equal((await h.request('STOP', { sessionId: 'session' })).ok, true);
  assert.ok(h.store.recording.stopRequestedAt); assert.equal(h.contextExists(), true);
  h.time.fire(6000); await until(() => h.store.recording.forced);
  assert.equal(h.contextExists(), false); assert.equal(h.store.recording.status, 'interrupted');
});

test('正常释放状态会取消后台停止看门狗，保存期间不误关进程', async t => {
  const h = await harness(t); await h.request('STOP', { sessionId: 'session' });
  await h.request('STATE', { state: { ...h.store.recording, status: 'saving', released: true, sequence: 6 } });
  assert.equal(h.time.has(6000), false); assert.equal(h.contextExists(), true);
  assert.equal(h.store.recording.status, 'saving'); assert.equal(h.calls.some(call => call.closedOffscreen), false);
});

test('旧看门狗晚到时不能关闭新会话的离屏录制', async t => {
  const h = await harness(t); await h.request('STOP', { sessionId: 'session' });
  const staleWatchdog = h.time.get(6000);
  h.store.recording = { status: 'recording', sessionId: 'new', tabId: 7, sequence: 1, id: 'new-video' };
  h.store.captureSession = { kind: 'web', sessionId: 'new' };
  staleWatchdog(); await tick();
  assert.equal(h.contextExists(), true); assert.equal(h.store.captureSession.sessionId, 'new');
  assert.equal(h.calls.some(call => call.closedOffscreen), false);
});

test('离屏进程无法关闭时保留活动锁，不伪称停止成功或恢复文件', async t => {
  const h = await harness(t);
  h.chrome.offscreen.closeDocument = async () => { throw new Error('renderer stuck'); };
  const result = await h.request('FORCE_STOP', { sessionId: 'session' });
  assert.equal(result.ok, false); assert.equal(h.store.recording.stopFailed, true);
  assert.equal(h.store.recording.status, 'recording'); assert.equal(h.store.recording.released, undefined);
  assert.equal(h.store.captureSession.sessionId, 'session'); assert.equal(h.calls.some(call => call.dbGet), false);
});

test('强制停止后迟到的正常完成消息不能覆盖恢复状态', async t => {
  const h = await harness(t); await h.request('FORCE_STOP', { sessionId: 'session' });
  const result = await h.request('STATE', { state: { status: 'complete', sessionId: 'session', tabId: 7, sequence: 999 } });
  assert.equal(result.ignored, true); assert.equal(h.store.recording.status, 'interrupted');
});

test('强制停止发现文件已经完整保存时保留complete，不降级成片', async t => {
  const h = await harness(t, { recordStatus: 'complete' });
  await h.request('FORCE_STOP', { sessionId: 'session' });
  assert.equal(h.store.recording.status, 'complete'); assert.equal(h.store.recording.error, null);
  assert.equal(h.calls.some(call => call.dbPatch), false);
});

test('采集已关闭而恢复查询卡住时仍有界退出，片段不删除', async t => {
  const h = await harness(t);
  // Delay the read without replacing the function captured by the module.
  h.records.get = () => new Promise(() => {});
  const pending = h.request('FORCE_STOP', { sessionId: 'session' });
  await until(() => !h.contextExists());
  await until(() => h.time.has(2500)); h.time.fire(2500);
  const result = await pending;
  assert.equal(result.ok, true); assert.equal(h.store.recording.status, 'error');
  assert.equal(h.store.recording.released, true); assert.equal(h.store.captureSession, null);
});

for (const type of ['PAUSE', 'RESUME', 'STOP', 'FORCE_STOP']) {
  test(`旧会话${type}不能被重新绑定到当前录制`, async t => {
    const h = await harness(t);
    const result = await h.request(type, { sessionId: 'old' });
    assert.equal(result.ignored, true); assert.equal(h.store.recording.status, 'recording');
    assert.equal(h.calls.some(call => call.target === 'offscreen' || call.closedOffscreen), false);
  });
}

test('STOP两次状态读取之间切换会话时，不创建过时看门狗或发送控制', async t => {
  const h = await harness(t), get = h.chrome.storage.session.get;
  let recordingReads = 0;
  h.chrome.storage.session.get = async keys => {
    const snapshot = await get(keys);
    if (keys === 'recording' && ++recordingReads === 1) {
      h.store.recording = { status: 'recording', tabId: 7, sessionId: 'new', id: 'new-video', sequence: 1, autoExport: false };
      h.store.captureSession = { kind: 'web', sessionId: 'new' };
    }
    return snapshot;
  };
  const result = await h.request('STOP', { sessionId: 'session' });
  assert.equal(result.ignored, true); assert.equal(h.time.has(6000), false);
  assert.equal(h.calls.some(call => call.target === 'offscreen' || call.closedOffscreen), false);
  assert.equal(h.store.captureSession.sessionId, 'new');
});

test('状态查询确认进程消失后恢复部分文件，而不是只改界面报错', async t => {
  const h = await harness(t, { contexts: false });
  const result = await h.request('GET_STATE');
  assert.equal(result.recording.status, 'interrupted'); assert.equal(result.recording.bytes, 4321);
  assert.equal(h.records.get('video').status, 'interrupted'); assert.equal(h.store.captureSession, null);
});

test('状态查询时进程已消失但文件完整落盘，不误报录制失败', async t => {
  const h = await harness(t, { contexts: false, recordStatus: 'complete' });
  const result = await h.request('GET_STATE');
  assert.equal(result.recording.status, 'complete'); assert.equal(result.recording.duration, 2500);
  assert.equal(h.store.captureSession, null); assert.equal(h.calls.some(call => call.dbPatch), false);
});
