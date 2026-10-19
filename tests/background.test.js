import test from 'node:test';
import assert from 'node:assert/strict';

async function harness() {
  const store = { targetTab: { id: 7, title: '演示项目', url: 'https://example.test/' } };
  const calls = []; let listener, updated, activated;
  globalThis.chrome = {
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      getManifest: () => ({ version: '0.1.1' }),
      getContexts: async () => [], onMessage: { addListener: fn => listener = fn },
      sendMessage: async message => { calls.push(message); return { ok: true }; } },
    action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} },
    sidePanel: { open: async () => {} },
    storage: { session: { get: async () => structuredClone(store), set: async data => Object.assign(store, data) } },
    tabs: { get: async id => ({ ...store.targetTab, id }), query: async () => [{ ...store.targetTab }],
      sendMessage: async (id, message) => { calls.push({ id, ...message }); return { ok: true, width: 1200, height: 800 }; }, onUpdated: { addListener(fn) { updated = fn; } }, onActivated: { addListener(fn) { activated = fn; } } },
    scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
    offscreen: { createDocument: async () => calls.push({ createdOffscreen: true }), closeDocument: async () => calls.push({ closedOffscreen: true }) },
    tabCapture: { getMediaStreamId: async options => { calls.push(options); return 'test-stream-id'; } }
  };
  await import(`../background.js?run=${Math.random()}`);
  const request = (type, extra = {}, sender = { id: 'test-extension', url: 'chrome-extension://test-extension/panel.html' }) => new Promise(resolve => {
    listener({ target: 'background', type, ...extra }, sender, resolve);
  });
  return { store, calls, request, updated: (...args) => updated(...args), activated: info => activated(info) };
}

function multipleWindows(h) {
  const tabs = new Map([
    [7, { id: 7, windowId: 1, title: '网页A', url: 'https://a.example/' }],
    [8, { id: 8, windowId: 1, title: '网页B', url: 'https://b.example/' }],
    [20, { id: 20, windowId: 2, title: '另一个窗口', url: 'https://c.example/' }]
  ]);
  const active = new Map([[1, 7], [2, 20]]), queries = [];
  h.store.targetTab = tabs.get(7);
  chrome.tabs.query = async query => { queries.push(query); return [tabs.get(active.get(query.windowId ?? 2))]; };
  chrome.tabs.get = async id => { if (!tabs.has(id)) throw new Error('tab closed'); return tabs.get(id); };
  return { tabs, active, queries };
}
test('后台将框选和音频设置交给离屏录制，且锁定原网页', async () => {
  const h = await harness();
  h.store.crop = { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  assert.equal((await h.request('START', { selectionId: 'selected', options: { range: 'region', audio: true } })).ok, true);
  const start = h.calls.find(c => c.target === 'offscreen' && c.type === 'START');
  assert.deepEqual(start.options.crop, h.store.crop);
  assert.equal(start.options.context.tabId, 7);
  assert.equal(start.options.audio, true);
  assert.equal(start.streamId, 'test-stream-id');
});
test('缺失矩形坐标的旧框选数据不能用于录制', async () => {
  const h = await harness();
  h.store.crop = { viewportWidth: 1000, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  const result = await h.request('START', { selectionId: 'selected', options: { range: 'region' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /框选范围无效/);
  assert.equal(h.calls.some(c => c.type === 'START'), false);
});

test('获得真实流后按稳定 CSS 视口保留框选像素矩形，启动变化不提前停止', async () => {
  const h = await harness();
  h.store.crop = { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  const tabSend = chrome.tabs.sendMessage, runtimeSend = chrome.runtime.sendMessage;
  let confirmed;
  chrome.tabs.sendMessage = (id, message) => message.type === 'CAPTURE_VIEWPORT' ? Promise.resolve({ ok: true, width: 1000, height: 600 }) : tabSend(id, message);
  chrome.runtime.sendMessage = async message => {
    const response = await runtimeSend(message);
    if (message.target !== 'offscreen' || message.type !== 'START') return response;
    const sessionId = message.options.context.sessionId;
    const early = await h.request('VIEWPORT_RESIZE', { sessionId, width: 1000, height: 600 }, { id: chrome.runtime.id, url: 'https://example.test/', tab: { id: 7 }, frameId: 0 });
    assert.equal(early.ignored, true);
    confirmed = await h.request('CAPTURE_VIEWPORT_READY', { sessionId }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') });
    // The recorder publishes preparing before its source factory has returned.
    // That older snapshot may reach the worker after viewport confirmation.
    await h.request('STATE', { state: { status: 'preparing', sessionId, sequence: 1,
      cropViewport: { viewportWidth: 1200, viewportHeight: 800 }, cropViewportPending: true } });
    return confirmed;
  };
  assert.equal((await h.request('START', { selectionId: 'selected', options: { range: 'region' } })).ok, true);
  assert.equal(confirmed.crop.x * 1000, 120); assert.equal(confirmed.crop.y * 600, 160);
  assert.equal(confirmed.crop.width * 1000, 600); assert.equal(confirmed.crop.height * 600, 400);
  assert.deepEqual(h.store.recording.cropViewport, { viewportWidth: 1000, viewportHeight: 600 });
  assert.equal(h.store.recording.cropViewportPending, false);
  assert.equal(h.calls.find(message => message.type === 'BEGIN').options.deferViewport, true);
  assert.ok(h.calls.some(message => message.type === 'ARM_VIEWPORT'));
});

test('采集提示改变可见范围后原矩形越界会明确拒绝，不静默裁掉选区', async () => {
  const h = await harness();
  h.store.crop = { x: .1, y: .7, width: .5, height: .3, viewportWidth: 1200, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  const tabSend = chrome.tabs.sendMessage, runtimeSend = chrome.runtime.sendMessage;
  chrome.tabs.sendMessage = (id, message) => message.type === 'CAPTURE_VIEWPORT' ? Promise.resolve({ ok: true, width: 1200, height: 740 }) : tabSend(id, message);
  chrome.runtime.sendMessage = async message => {
    const response = await runtimeSend(message);
    return message.target === 'offscreen' && message.type === 'START'
      ? h.request('CAPTURE_VIEWPORT_READY', { sessionId: message.options.context.sessionId }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') }) : response;
  };
  const result = await h.request('START', { selectionId: 'selected', options: { range: 'region' } });
  assert.equal(result.ok, false); assert.match(result.error, /超出画面.*重新框选/);
  assert.equal(h.calls.some(message => message.type === 'ARM_VIEWPORT'), false);
});

test('取消期间迟到的视口确认不再武装旧会话，其他来源不能确认范围', async () => {
  const h = await harness(); let resolveViewport, confirmed;
  h.store.crop = { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  const tabSend = chrome.tabs.sendMessage, runtimeSend = chrome.runtime.sendMessage;
  chrome.tabs.sendMessage = (id, message) => message.type === 'CAPTURE_VIEWPORT' ? new Promise(resolve => { resolveViewport = resolve; }) : tabSend(id, message);
  chrome.runtime.sendMessage = async message => {
    const response = await runtimeSend(message);
    if (message.target !== 'offscreen' || message.type !== 'START') return response;
    confirmed = await h.request('CAPTURE_VIEWPORT_READY', { sessionId: message.options.context.sessionId }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') });
    return confirmed;
  };
  const starting = h.request('START', { selectionId: 'selected', options: { range: 'region' } });
  for (let i = 0; i < 50 && !resolveViewport; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(resolveViewport);
  assert.equal((await h.request('CAPTURE_VIEWPORT_READY', { sessionId: h.store.recording.sessionId })).ok, false);
  await h.request('STOP', { sessionId: h.store.recording.sessionId });
  resolveViewport({ ok: true, width: 1200, height: 740 });
  await starting; await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed.ok, false); assert.equal(h.calls.some(message => message.type === 'ARM_VIEWPORT'), false);
});

for (const change of [{ status: 'loading' }, { url: 'https://example.test/new' }]) test(`区域准备期间导航 ${JSON.stringify(change)} 取消旧选区，迟到确认不能继续`, async () => {
  const h = await harness(); let resolveViewport, confirmed;
  h.store.crop = { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.store.cropSelectionId = 'selected';
  const tabSend = chrome.tabs.sendMessage, runtimeSend = chrome.runtime.sendMessage;
  chrome.tabs.sendMessage = (id, message) => message.type === 'CAPTURE_VIEWPORT' ? new Promise(resolve => { resolveViewport = resolve; }) : tabSend(id, message);
  chrome.runtime.sendMessage = async message => {
    const response = await runtimeSend(message);
    if (message.target !== 'offscreen' || message.type !== 'START') return response;
    confirmed = await h.request('CAPTURE_VIEWPORT_READY', { sessionId: message.options.context.sessionId }, { id: chrome.runtime.id, url: chrome.runtime.getURL('offscreen.html') });
    return confirmed;
  };
  const starting = h.request('START', { selectionId: 'selected', options: { range: 'region' } });
  for (let i = 0; i < 50 && !resolveViewport; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(resolveViewport);
  await h.updated(7, change);
  const result = await starting;
  assert.equal(result.ok, false); assert.match(result.error, /跳转或刷新.*尚未开始/);
  assert.equal(h.store.captureSession, null);
  resolveViewport({ ok: true, width: 1200, height: 740 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed.ok, false); assert.equal(h.calls.some(message => message.type === 'ARM_VIEWPORT'), false);
});
test('录制中拒绝第二次开始，拒绝重选范围', async () => {
  const h = await harness(); h.store.recording = { status: 'recording', tabId: 7 };
  assert.equal((await h.request('START', { options: {} })).ok, false);
  assert.equal((await h.request('OVERLAY', { command: 'CROP' })).ok, false);
});
test('网页内容不能伪造录制完成状态', async () => {
  const h = await harness();
  const result = await h.request('STATE', { state: { status: 'complete' } }, { id: 'test-extension', url: 'https://example.test/', tab: { id: 7 } });
  assert.equal(result.ok, false); assert.equal(h.store.recording, undefined);
});
test('权限或流获取失败时保存明确的错误状态', async () => {
  const h = await harness(); chrome.tabCapture.getMediaStreamId = async () => { throw new Error('Permission denied'); };
  const result = await h.request('START', { options: { range: 'full' } });
  assert.equal(result.ok, false); assert.equal(h.store.recording.status, 'error');
  assert.equal(h.store.recording.error, 'Permission denied');
});

test('标注初始化报错保留真实原因，不误报普通网页为受保护页面', async () => {
  const h = await harness();
  chrome.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist.'); };
  chrome.scripting.executeScript = async () => [{ frameId: 0, result: { ok: false, error: 'TypeError: Failed to initialize overlay' } }];
  const result = await h.request('CONNECT');
  assert.equal(result.ok, false);
  assert.match(result.error, /标注启动失败/);
  assert.match(result.detail, /TypeError: Failed to initialize overlay/);
  assert.equal(h.store.connection.status, 'error');
  assert.doesNotMatch(result.error, /设置页|扩展商店/);
});

test('重新连接当前网页会更新目标并清除上次连接错误', async () => {
  const h = await harness();
  h.store.recording = { status: 'error', error: '旧错误' };
  h.store.crop = { x: .1, y: .1, width: .5, height: .5 };
  chrome.tabs.query = async () => [{ id: 12, title: '鹧鸪项目', url: 'https://yydshly.github.io/partridge-bike/' }];
  assert.equal((await h.request('CONNECT')).ok, true);
  assert.equal(h.store.targetTab.id, 12);
  assert.equal(h.store.crop, null);
  assert.equal(h.store.recording.status, 'idle');
  assert.equal(h.store.connection.status, 'connected');
});

test('只有确认为浏览器内部页时才显示内部页提示', async () => {
  const h = await harness(); h.store.targetTab.url = 'chrome://extensions/';
  let injections = 0; chrome.scripting.executeScript = async () => { injections++; };
  const result = await h.request('CONNECT');
  assert.match(result.error, /浏览器内部页面/);
  assert.equal(injections, 0);
});

test('缺少 activeTab 授权时给出授权动作并保留详情', async () => {
  const h = await harness();
  chrome.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist.'); };
  chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of url. Extension manifest must request permission.'); };
  const result = await h.request('CONNECT');
  assert.match(result.error, /尚未授权这个网页/);
  assert.match(result.detail, /Cannot access contents/);
});

test('侧栏以握手成功判断连接，不把已保存的目标当作已连接', async () => {
  const h = await harness();
  chrome.tabs.sendMessage = async () => undefined;
  const state = await h.request('GET_STATE');
  assert.equal(state.connected, false);
  assert.equal(state.targetTab.id, 7);
});

test('录制中重新连接不会切换来源或清空框选', async () => {
  const h = await harness(); h.store.recording = { status: 'recording', tabId: 7 };
  assert.equal((await h.request('CONNECT')).ok, false);
  assert.equal(h.store.targetTab.id, 7);
});

test('录制音乐配置独立于网页声音，后台原样传给离屏混音', async () => {
  const h = await harness(), music = { id: 'song', volume: .2, loop: true };
  assert.equal((await h.request('START', { options: { range: 'full', audio: false, music } })).ok, true);
  const start = h.calls.find(call => call.target === 'offscreen' && call.type === 'START');
  assert.deepEqual(start.options.music, music); assert.equal(start.options.audio, false);
});

test('音乐控制拒绝网页伪造并忽略旧会话，不创建新的录制或离屏进程', async () => {
  const h = await harness(); h.store.recording = { status: 'recording', sessionId: 'new', tabId: 7 };
  assert.equal((await h.request('MUSIC', { sessionId: 'old', command: 'play' })).ignored, true);
  assert.equal((await h.request('MUSIC', { sessionId: 'new', command: 'play' }, { id: 'test-extension', url: 'https://example.test/', tab: { id: 7 } })).ok, false);
  assert.equal(h.calls.some(call => call.target === 'offscreen' || call.createdOffscreen), false);
  assert.equal((await h.request('MUSIC', { sessionId: 'new', command: 'volume', value: .3 })).ok, true);
  assert.equal(h.calls.at(-1).sessionId, 'new'); assert.equal(h.calls.at(-1).command, 'volume');
});

test('框选结果持久化后向侧栏发送自动开始事件', async () => {
  const h = await harness();
  await h.request('OVERLAY', { command: 'CROP', options: { selectionId: 'selection' } });
  const crop = { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  await h.request('CROP', { crop, selectionId: 'selection' }, { id: 'test-extension', url: 'https://example.test/', tab: { id: 7 } });
  assert.deepEqual(h.store.crop, crop);
  assert.deepEqual(h.calls.find(c => c.type === 'CROP_READY').crop, crop);
});

test('旧状态查询不会覆盖已完成的新状态', async () => {
  const h = await harness();
  h.store.recording = { status: 'saving', tabId: 7, sessionId: 'session', sequence: 5 };
  let resolveStatus, requested;
  const entered = new Promise(resolve => { requested = resolve; });
  chrome.runtime.sendMessage = async msg => {
    if (msg.target === 'offscreen' && msg.type === 'STATUS') { requested(); return new Promise(resolve => { resolveStatus = resolve; }); }
    return { ok: true };
  };
  const read = h.request('GET_STATE'); await entered;
  await h.request('STATE', { state: { status: 'complete', tabId: 7, sessionId: 'session', sequence: 7 } });
  resolveStatus(undefined);
  assert.equal((await read).recording.status, 'complete');
  assert.equal(h.store.recording.sequence, 7);
});

test('结束通知丢失时查询真实录制器可以修复保存中状态', async () => {
  const h = await harness();
  h.store.recording = { status: 'saving', tabId: 7, sessionId: 'session', sequence: 5 };
  chrome.runtime.sendMessage = async msg => msg.target === 'offscreen' ? { state: { status: 'complete', tabId: 7, sessionId: 'session', sequence: 7 } } : { ok: true };
  assert.equal((await h.request('GET_STATE')).recording.status, 'complete');
  assert.equal(h.store.recording.status, 'complete');
});

test('取消连接可立即返回，迟到的来源不会启动录制', async () => {
  const h = await harness(); let resolveStream, requested;
  const entered = new Promise(resolve => { requested = resolve; });
  chrome.tabCapture.getMediaStreamId = () => { requested(); return new Promise(resolve => { resolveStream = resolve; }); };
  const start = h.request('START', { options: { range: 'full' } }); await entered;
  const id = h.store.recording.sessionId;
  assert.equal((await h.request('STOP')).ok, true);
  assert.equal((await start).cancelled, true);
  assert.equal(h.store.recording.status, 'cancelled');
  assert.equal(h.store.captureSession, null);
  resolveStream('late-stream'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.some(c => c.target === 'offscreen' && c.type === 'START'), false);
  await h.request('STATE', { state: { status: 'recording', sessionId: id, sequence: 999 } });
  assert.equal(h.store.recording.status, 'cancelled');
});

test('桌面和网页共用单次录制限制，只有拥有者可以释放', async () => {
  const h = await harness();
  const desktop = { id: 'test-extension', url: chrome.runtime.getURL('desktop.html'), tab: { id: 21 } };
  chrome.tabs.get = async id => id === 7 ? { ...h.store.targetTab } : { id, url: chrome.runtime.getURL('desktop.html') };
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'desktop' }, desktop)).ok, true);
  assert.equal((await h.request('START', { options: { range: 'full' } })).ok, false);
  assert.equal((await h.request('DESKTOP_ACQUIRE', { sessionId: 'other' }, { ...desktop, tab: { id: 22 } })).ok, false);
  await h.request('DESKTOP_STATE', { state: { status: 'paused', sessionId: 'desktop', sequence: 2, id: 'file' } }, desktop);
  assert.deepEqual((await h.request('GET_ACTIVE_RECORDINGS')).ids, ['file']);
  await h.request('DESKTOP_RELEASE', { sessionId: 'desktop' }, { ...desktop, tab: { id: 22 } });
  assert.equal(h.store.captureSession.sessionId, 'desktop');
  await h.request('DESKTOP_STATE', { state: { status: 'complete', sessionId: 'desktop', sequence: 3, id: 'file' } }, desktop);
  assert.equal(h.store.captureSession, null);
  assert.equal((await h.request('START', { options: { range: 'full' } })).ok, true);
});

test('旧框选结果不能写入新的范围或自动触发新录制', async () => {
  const h = await harness();
  await h.request('OVERLAY', { command: 'CROP', options: { selectionId: 'old' } });
  await h.request('OVERLAY', { command: 'CANCEL_CROP', options: { selectionId: 'old' } });
  await h.request('OVERLAY', { command: 'CROP', options: { selectionId: 'new' } });
  const sender = { id: 'test-extension', url: 'https://example.test/', tab: { id: 7 } };
  assert.equal((await h.request('CROP', { selectionId: 'old', crop: { width: 1 } }, sender)).ignored, true);
  assert.equal(h.store.crop, null);
  assert.equal(h.calls.some(c => c.type === 'CROP_READY'), false);
});

test('采集释放后就恢复网页，不等文件保存完成', async () => {
  const h = await harness();
  await h.request('STATE', { state: { status: 'saving', released: true, tabId: 7 } });
  assert.equal(h.calls.some(c => c.target === 'overlay' && c.type === 'END'), true);
});

test('旧会话和乱序消息不能覆盖当前录制状态', async () => {
  const h = await harness(); h.store.recording = { status: 'recording', tabId: 7, sessionId: 'new', sequence: 5 };
  await h.request('STATE', { state: { status: 'complete', sessionId: 'old', sequence: 20 } });
  await h.request('STATE', { state: { status: 'preparing', sessionId: 'new', sequence: 2 } });
  assert.equal(h.store.recording.status, 'recording');
});

test('录制进程丢失后可以恢复到可重新开始的状态', async () => {
  const h = await harness(); h.store.recording = { status: 'recording', tabId: 7 };
  const result = await h.request('GET_STATE');
  assert.equal(result.recording.status, 'error');
  assert.match(result.recording.error, /进程已断开/);
});

test('自动恢复标注失败不会被静默忽略', async () => {
  const h = await harness(); chrome.tabs.sendMessage = async () => { throw new Error('disconnected'); };
  await h.request('STATE', { state: { status: 'saving', released: true, tabId: 7 } });
  assert.match(h.store.recording.restoreError, /未能自动收起/);
});

test('切换标签页后不会悄悄录制之前的网页', async () => {
  const h = await harness(); chrome.tabs.query = async () => [{ id: 99 }];
  const result = await h.request('START', { options: { range: 'full' } });
  assert.equal(result.ok, false); assert.match(result.error, /网页已切换/);
  assert.equal(h.calls.some(c => c.target === 'offscreen' && c.type === 'START'), false);
});

test('空闲侧栏显示自己窗口当前网页，不沿用上次点击图标的网页', async () => {
  const h = await harness(); const w = multipleWindows(h); w.active.set(1, 8);
  const result = await h.request('GET_STATE', { windowId: 1, tabId: 7 });
  assert.equal(result.targetTab.id, 8); assert.equal(result.connected, true); assert.equal(result.isCurrentTab, true);
  assert.equal(h.calls.some(call => call.target === 'overlay' && call.id === 7), false);
  assert.equal(w.queries.at(-1).windowId, 1);
});

test('两个窗口同时开侧栏不会抢来源或误用最后活动窗口', async () => {
  const h = await harness(); const w = multipleWindows(h);
  await h.request('CONNECT', { windowId: 2, tabId: 20 });
  assert.equal(h.store.targetTab.id, 20);
  const firstWindow = await h.request('GET_STATE', { windowId: 1 });
  assert.equal(firstWindow.targetTab.id, 7);
  assert.equal((await h.request('START', { windowId: 1, tabId: 7, options: { range: 'full' } })).ok, true);
  const start = h.calls.find(call => call.target === 'offscreen' && call.type === 'START');
  assert.equal(start.options.context.tabId, 7); assert.equal(start.options.title, '网页A');
  assert.equal(start.options.context.sourceTab.windowId, 1);
  assert.equal(w.queries.some(query => query.currentWindow), false);
});

test('新网页没有标注连接时显示待授权，不把旧网页连接当成功', async () => {
  const h = await harness(); const w = multipleWindows(h); w.active.set(1, 8);
  const send = chrome.tabs.sendMessage; let injections = 0;
  chrome.tabs.sendMessage = (id, msg) => id === 8 ? Promise.resolve(undefined) : send(id, msg);
  chrome.scripting.executeScript = async () => { injections++; };
  const state = await h.request('GET_STATE', { windowId: 1 });
  assert.equal(state.targetTab.id, 8); assert.equal(state.connected, false); assert.equal(state.needsActivation, true);
  assert.equal(injections, 0); assert.equal(h.store.targetTab.id, 7);
});

test('切换网页后正在录制的来源固定，侧栏不能向隐藏来源画图', async () => {
  const h = await harness(); const w = multipleWindows(h); w.active.set(1, 8);
  h.store.recording = { status: 'recording', sessionId: 'session', sequence: 5, tabId: 7, sourceTab: w.tabs.get(7) };
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = msg => msg.target === 'offscreen' && msg.type === 'STATUS' ? Promise.resolve({ state: structuredClone(h.store.recording) }) : send(msg);
  const state = await h.request('GET_STATE', { windowId: 1, tabId: 8 });
  assert.equal(state.targetTab.id, 7); assert.equal(state.isCurrentTab, false); assert.equal(state.connected, false);
  assert.equal(state.recording.status, 'recording');
  const draw = await h.request('OVERLAY', { windowId: 1, tabId: 8, command: 'SET', options: { tool: 'rect' } });
  assert.equal(draw.ok, false); assert.equal(h.calls.some(call => call.target === 'overlay' && call.type === 'SET'), false);
  assert.equal((await h.request('STOP', { windowId: 1, tabId: 8 })).ok, true);
  assert.equal(h.calls.find(call => call.target === 'offscreen' && call.type === 'STOP').sessionId, 'session');
});

test('在窗口内切换网页会取消旧框选，切换其他窗口不影响它', async () => {
  const h = await harness(); multipleWindows(h);
  await h.request('OVERLAY', { windowId: 1, tabId: 7, command: 'CROP', options: { selectionId: 'first' } });
  h.activated({ windowId: 2, tabId: 20 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.selection.id, 'first');
  h.activated({ windowId: 1, tabId: 8 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.selection, null);
  assert.equal(h.calls.some(call => call.type === 'CROP_CANCEL' && call.selectionId === 'first' && call.windowId === 1), true);
  assert.equal(h.calls.some(call => call.target === 'overlay' && call.type === 'CANCEL_CROP' && call.id === 7), true);
});

test('窗口之间不能复用另一网页的框选范围', async () => {
  const h = await harness(); multipleWindows(h);
  await h.request('OVERLAY', { windowId: 2, tabId: 20, command: 'CROP', options: { selectionId: 'other-window' } });
  await h.request('CROP', { selectionId: 'other-window', crop: { x: 0, y: 0, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 } },
    { id: 'test-extension', url: 'https://c.example/', tab: { id: 20, windowId: 2 } });
  const result = await h.request('START', { windowId: 1, tabId: 7, selectionId: 'other-window', options: { range: 'region' } });
  assert.equal(result.ok, false); assert.match(result.error, /拖动选择/);
  assert.equal(h.calls.some(call => call.target === 'offscreen' && call.type === 'START'), false);
});

test('迟到的旧页工具操作不重定向到新录制源，旧框选取消仍发往旧页', async () => {
  const h = await harness(); const w = multipleWindows(h); w.active.set(1, 8);
  h.store.recording = { status: 'recording', tabId: 8, sessionId: 'session', sequence: 5 };
  h.store.selection = { id: 'new', tabId: 8, windowId: 1 };
  const result = await h.request('OVERLAY', { windowId: 1, tabId: 7, command: 'SET', options: { tool: 'rect' } });
  assert.equal(result.ok, false); assert.equal(h.calls.some(call => call.target === 'overlay' && call.type === 'SET'), false);
  await h.request('OVERLAY', { windowId: 1, tabId: 7, command: 'CANCEL_CROP', options: { selectionId: 'old' } });
  assert.equal(h.calls.some(call => call.type === 'CANCEL_CROP' && call.id === 7), true);
  assert.equal(h.store.selection.id, 'new');
});

test('另一个网页的启动错误不泄漏到当前页，也不删除会话防重信息', async () => {
  const h = await harness(); const w = multipleWindows(h); w.active.set(1, 8);
  h.store.recording = { status: 'error', tabId: 7, sessionId: 'old', aborted: true, error: '网页已切换' };
  const state = await h.request('GET_STATE', { windowId: 1 });
  assert.equal(state.recording.status, 'idle'); assert.equal(state.targetTab.id, 8);
  assert.equal(h.store.recording.sessionId, 'old'); assert.equal(h.store.recording.aborted, true);
});

test('区域录制检测到CSS视口变化时安全停止，旧会话通知无效', async () => {
  const h = await harness();
  h.store.recording = { status: 'recording', sessionId: 'current', tabId: 7, cropViewport: { viewportWidth: 1200, viewportHeight: 800 } };
  const sender = { id: 'test-extension', url: 'https://example.test/', tab: { id: 7 } };
  assert.equal((await h.request('VIEWPORT_RESIZE', { sessionId: 'old', width: 1000, height: 800 }, sender)).ignored, true);
  assert.equal(h.calls.some(c => c.type === 'STOP'), false);
  await h.request('VIEWPORT_RESIZE', { sessionId: 'current', width: 1000, height: 800 }, sender);
  assert.match(h.calls.find(c => c.type === 'STOP').error, /重新框选/);
});

test('并发连接与开始共享协调器，不会覆盖新会话或泄漏锁', async () => {
  const h = await harness();
  h.store.recording = { status: 'error', sessionId: 'old', sequence: 4, aborted: true };
  let sourceRequested, rejectSource;
  const entered = new Promise(resolve => { sourceRequested = resolve; });
  chrome.tabCapture.getMediaStreamId = () => { sourceRequested(); return new Promise((resolve, reject) => { rejectSource = reject; }); };
  const start = h.request('START', { options: { range: 'full' } }); await entered;
  assert.equal((await h.request('CONNECT')).ok, false);
  rejectSource(new Error('source failed'));
  assert.equal((await start).ok, false);
  assert.equal(h.store.recording.status, 'error'); assert.equal(h.store.captureSession, null);
  await h.request('CONNECT');
  assert.equal(h.store.recording.status, 'idle');
  await h.request('STATE', { state: { status: 'recording', sessionId: 'old', sequence: 999 } });
  assert.equal(h.store.recording.status, 'idle');
});

test('开始后立即取消不会错过准备阶段', async () => {
  const h = await harness();
  const start = h.request('START', { options: { range: 'full' } });
  const stop = h.request('STOP');
  assert.equal((await stop).ok, true);
  assert.equal((await start).cancelled, true);
  assert.equal(h.store.recording.status, 'cancelled');
  assert.equal(h.store.captureSession, null);
});

test('网页卡住不回复END时后台仍能完成收尾并释放会话', async t => {
  const h = await harness();
  h.store.recording = { status: 'saving', tabId: 7, sessionId: 'session', sequence: 5 };
  h.store.captureSession = { kind: 'web', sessionId: 'session' };
  chrome.tabs.sendMessage = () => new Promise(() => {});
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const result = await h.request('STATE', { state: { status: 'complete', tabId: 7, sessionId: 'session', sequence: 7 } });
  assert.equal(result.ok, true); assert.equal(h.store.recording.status, 'complete');
  assert.match(h.store.recording.restoreError, /未能自动收起/); assert.equal(h.store.captureSession, null);
});

test('状态查询未响应但进程仍存在时保留录制，不强制关闭', async () => {
  const h = await harness();
  h.store.recording = { status: 'recording', tabId: 7, sessionId: 'session', sequence: 5 };
  h.store.captureSession = { kind: 'web', sessionId: 'session' };
  chrome.runtime.getContexts = async () => [{}];
  const result = await h.request('GET_STATE');
  assert.equal(result.recording.status, 'recording'); assert.match(result.warning, /暂未响应/);
  assert.equal(h.store.captureSession.sessionId, 'session');
  assert.equal(h.calls.some(c => c.closedOffscreen), false);
});

test('刷新后的迟到连接不会在停止后重新启用标注', async () => {
  const h = await harness();
  h.store.recording = { status: 'recording', tabId: 7, sessionId: 'session', sequence: 5 };
  let resolvePing, requested;
  const entered = new Promise(resolve => { requested = resolve; });
  const originalSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = (id, msg) => {
    if (msg.type === 'PING') { requested(); return new Promise(resolve => { resolvePing = resolve; }); }
    return originalSend(id, msg);
  };
  await h.updated(7, { status: 'complete' }); await entered;
  await h.request('STATE', { state: { status: 'complete', sessionId: 'session', tabId: 7, sequence: 7 } });
  resolvePing({ ok: true, width: 1200, height: 800 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.some(c => c.type === 'BEGIN'), false);
});
