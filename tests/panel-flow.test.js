import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chooseRecordingMime, isRecordingFormatSupported } from '../lib/media-format.js';
const source = await readFile(new URL('../panel.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('标注容量提示仅显示当前窗口和网页，不改变开始录制能力', async t => {
  const h = await harness(t);
  h.send({ type: 'ANNOTATION_ERROR', tabId: 8, windowId: 4, error: '其他网页' }); assert.equal(h.get('error').hidden, true);
  h.send({ type: 'ANNOTATION_ERROR', tabId: 7, windowId: 99, error: '其他窗口' }); assert.equal(h.get('error').hidden, true);
  h.send({ type: 'ANNOTATION_ERROR', tabId: 7, windowId: 4, error: '本页标注较多，请删除部分图形。' });
  assert.match(h.get('error').textContent, /标注较多/); assert.equal(h.get('start').disabled, false);
  assert.equal(h.calls.some(message => message.type === 'STOP'), false);
});

test('录制进度只更新计时，不重复重建控制区；标题消息不触发连接查询',async t=>{
  const h=await harness(t),state={id:'one',sessionId:'one',tabId:7,status:'recording',startedAt:Date.now()};
  h.send({type:'STATE',state});const dot=h.get('status-label').children[0];h.calls.length=0;
  for(let i=1;i<=100;i++)h.send({type:'STATE',state:{...state,bytes:i}});
  assert.equal(h.get('status-label').children[0],dot);assert.equal(h.calls.length,0);
  h.send({type:'PAGE_TITLE',windowId:4,tabId:7,title:'新标题'});assert.equal(h.get('page-title').textContent,'新标题');assert.equal(h.calls.length,0);
  h.send({type:'PAGE_TITLE',windowId:99,tabId:7,title:'其他窗口'});assert.equal(h.get('page-title').textContent,'新标题');
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness(t, options = {}) {
  const elements = new Map(), calls = [], savedSettings = [], openedPages = [], intervals = new Map(), documentHandlers = {}, windowHandlers = {}; let listener, nextInterval = 0, materialControls, musicControls;
  const windowId = options.windowId ?? 4;
  let response = { ok: true, connected: true, isCurrentTab: true, recording: { status: 'idle' }, targetTab: { id: 7, windowId, title: 'project', url: 'https://example.test' } };
  class Element {
    constructor(id) { this.id = id; this.classList = { toggle() {}, add() {} }; this.handlers = {}; this.value = ({ quality: '1080', fps: '30', format: 'webm', width: '4', 'font-size': '28' })[id] || ''; this.checked = id !== 'diagnostics'; this.type = ['audio', 'microphone', 'diagnostics'].includes(id) ? 'checkbox' : ''; }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    replaceChildren() { this.children = []; } append(...children) { (this.children ||= []).push(...children); } setAttribute() {}
    showModal() { this.open = true; } close() { this.open = false; }
    click() { this.clicked = (this.clicked || 0) + 1; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const tools = ['pointer', 'rect', 'text'].map(tool => { const button = get(`tool-${tool}`); button.dataset = { tool }; return button; });
  const saved = { document: globalThis.document, window: globalThis.window, chrome: globalThis.chrome, panelTestFormats: globalThis.panelTestFormats, MediaRecorder: globalThis.MediaRecorder };
  globalThis.panelTestFormats = { chooseRecordingMime, isRecordingFormatSupported, prepareAnnotationImage: options.prepareImage || (async () => ({ src: 'data:image/png;base64,aGVsbG8=' })),
    createMaterialShelf: controls => { materialControls = controls; return { render() {}, refresh: async () => {} }; },
    createMusicPanel: controls => { musicControls = controls; return { render() {}, ready: Promise.resolve(), beforeRecording: options.beforeMusic || (async () => options.music || null) }; } };
  globalThis.MediaRecorder = { isTypeSupported: mime => !mime.startsWith('video/mp4') || options.mp4Supported !== false };
  let storageListener;
  globalThis.document = { hidden: false, addEventListener: (type, fn) => { documentHandlers[type] = fn; }, getElementById: get, querySelectorAll: selector => selector === '[data-tool]' || selector.startsWith('.tools button') ? tools : [], createElement: tag => new Element(tag), body: new Element('body') };
  globalThis.window = { addEventListener: (type, fn) => { windowHandlers[type] = fn; } };
  globalThis.chrome = { tabs: { create(page) { openedPages.push(page); } }, runtime: { id: 'test', getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: fn => listener = fn }, sendMessage: async msg => {
    calls.push(msg);
    if (msg.type === 'GET_STATE') return structuredClone(response);
    if (msg.type === 'GET_EXPORT_STATE') return { ok: true, export: options.exportState };
    return { ok: true };
  } }, storage: { onChanged: { addListener: fn => { storageListener = fn; } }, local: { get: options.getSettings || (async () => ({ settings: options.settings || {}, ...options.storedKeys })), set(value) { savedSettings.push(value); return Promise.resolve(); } } } };
  if (!options.legacyWindows) chrome.windows = { getCurrent: options.getCurrent || (async () => ({ id: windowId })) };
  const tabEvents = { activated: new Set(), updated: new Set() };
  if (options.tabEvents) for (const [key, event] of [['onActivated', 'activated'], ['onUpdated', 'updated']])
    chrome.tabs[key] = { addListener: fn => tabEvents[event].add(fn), removeListener: fn => tabEvents[event].delete(fn) };
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { const id = ++nextInterval; intervals.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
  t.after(() => Object.assign(globalThis, saved));
  const code = source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  await import('data:text/javascript;base64,' + Buffer.from('const {chooseRecordingMime,isRecordingFormatSupported,prepareAnnotationImage,createMaterialShelf,createMusicPanel}=globalThis.panelTestFormats;const clockText=()=>"00:00",elapsed=()=>0,fileSize=()=>"",listRecordingPage=async()=>({records:[]});\n' + code).toString('base64'));
  await tick(); calls.length = 0;
  return { get, calls, savedSettings, openedPages, intervals, documentHandlers, windowHandlers, materialControls, musicControls, tabEvents, update: data => { response = { ...response, ...data }; },
    activate: info => { for (const fn of tabEvents.activated) fn(info); },
    updateTab: (...args) => { for (const fn of tabEvents.updated) fn(...args); },
    storageChange: changes => storageListener(changes, 'local'),
    send: message => listener({ target: 'panel', tabId: response.targetTab?.id, ...message }) };
}

test('图片可在录制中添加到原网页及框选范围，取消文件选择不发出命令', async t => {
  const h = await harness(t);
  await h.get('add-image').onclick();
  assert.equal(h.get('image-file').clicked, 1);
  await h.get('image-file').onchange(); assert.equal(h.calls.length, 0);
  const crop = { x: .2, y: .1, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.update({ recording: { status: 'recording', sessionId: 'session', cropViewport: { viewportWidth: 1200, viewportHeight: 800 } }, crop });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  await h.get('add-image').onclick(); h.get('image-file').files = [{}]; await h.get('image-file').onchange();
  const command = h.calls.find(c => c.command === 'INSERT_IMAGE');
  assert.equal(command.tabId, 7); assert.equal(command.options.sessionId, 'session'); assert.deepEqual(command.options.region, crop);
  assert.equal(h.get('image-file').value, ''); assert.equal(h.get('add-image').disabled, false);
});

test('素材可离线提前准备，录制中仅使用已有素材且保留暂停和停止控制', async t => {
  const h = await harness(t), shelf = h.materialControls;
  h.update({ connected: false }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(shelf.canImport(), true); assert.equal(shelf.canUse(), false);
  const crop = { x: 0, y: 0, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  h.update({ connected: true, recording: { status: 'recording', sessionId: 'session', cropViewport: {} }, crop });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(shelf.canImport(), false); assert.equal(shelf.canUse(), true);
  const destination = shelf.captureDestination(); shelf.onBusy(true);
  assert.equal(h.get('add-image').disabled, true); assert.equal(h.get('stop').hidden, false); assert.equal(h.get('pause').hidden, false);
  await shelf.insert({ src: 'data:image/png;base64,aGVsbG8=' }, destination); shelf.onBusy(false);
  const command = h.calls.find(call => call.command === 'INSERT_IMAGE');
  assert.equal(command.tabId, 7); assert.equal(command.options.sessionId, 'session'); assert.deepEqual(command.options.region, crop);
});

test('使用备选图片期间换页或录制结束，不会向新的网页或会话插入旧图片', async t => {
  for (const change of ['tab', 'end']) {
    const h = await harness(t), shelf = h.materialControls;
    h.update({ recording: { status: 'recording', sessionId: 'old' } }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
    const destination = shelf.captureDestination();
    h.update(change === 'tab' ? { targetTab: { id: 8, windowId: 4 } } : { recording: { status: 'complete', sessionId: 'old' } });
    h.send({ type: 'REFRESH', windowId: 4 }); await tick();
    await assert.rejects(shelf.insert({ src: 'data:image/png;base64,aGVsbG8=' }, destination), /状态已变化/);
    assert.equal(h.calls.some(call => call.command === 'INSERT_IMAGE'), false);
  }
});

test('空闲、暂停、侧栏隐藏和关闭时没有计时轮询，仅可见录制使用一个秒级计时器', async t => {
  const h = await harness(t);
  assert.equal(h.intervals.size, 0); assert.equal(h.get('diagnostics').checked, false);
  h.send({ type: 'STATE', state: { status: 'recording' } });
  assert.equal(h.intervals.size, 1); assert.equal([...h.intervals.values()][0].ms, 1000);
  h.send({ type: 'STATE', state: { status: 'recording' } }); assert.equal(h.intervals.size, 1);
  document.hidden = true; h.documentHandlers.visibilitychange(); assert.equal(h.intervals.size, 0);
  document.hidden = false; h.documentHandlers.visibilitychange(); assert.equal(h.intervals.size, 1);
  h.send({ type: 'STATE', state: { status: 'paused' } }); assert.equal(h.intervals.size, 0);
  h.send({ type: 'STATE', state: { status: 'recording' } });
  h.windowHandlers.pagehide(); assert.equal(h.intervals.size, 0);
});

test('自动连接只在用户点击时请求一次权限，拒绝后不在刷新时重复弹窗', async t => {
  const h = await harness(t); const requests = [];
  chrome.permissions = { request: async value => { requests.push(value); return false; } };
  await h.get('auto-connect').onclick();
  assert.deepEqual(requests, [{ origins: ['http://*/*', 'https://*/*'] }]);
  assert.equal(h.get('error').hidden, true);
  assert.match(h.get('auto-connect-hint').textContent, /暂未开启/);
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  assert.equal(requests.length, 1); assert.equal(h.get('auto-connect').disabled, false);
  chrome.permissions.request = async () => true;
  h.update({ autoConnectEnabled: true, connected: true });
  await h.get('auto-connect').onclick(); assert.equal(h.get('auto-connect').hidden, true);
});

test('首次未授权优先展示授权引导，旧权限错误不显示成连接失败或准备就绪', async t => {
  const h = await harness(t);
  h.update({ connected: false, needsActivation: true, autoConnectEnabled: false, targetTab: { id: 8, windowId: 4 },
    connection: { status: 'error', error: 'Chrome 尚未授权这个网页', detail: '[inject] Cannot access contents' } });
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  assert.match(h.get('connection-label').textContent, /等待授权/);
  assert.equal(h.get('error').hidden, true); assert.equal(h.get('error-details').hidden, true);
  assert.equal(h.get('auto-connect-guide').hidden, false);
  assert.match(h.get('auto-connect-title').textContent, /首次使用/);
  assert.match(h.get('status-label').children.join(''), /等待网页授权/);
  assert.match(h.get('start').innerHTML, /先开启自动连接/);
  assert.equal(h.get('start').disabled, true);
});

test('授权取消后保留温和说明和再次开启入口，不弹红色错误或自动重复请求', async t => {
  const h = await harness(t); let requests = 0;
  chrome.permissions = { request: async () => { requests++; return false; } };
  h.update({ connected: false, needsActivation: true }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  await h.get('auto-connect').onclick();
  assert.equal(h.get('error').hidden, true); assert.match(h.get('connection-label').textContent, /等待授权/);
  assert.match(h.get('auto-connect-hint').textContent, /暂未开启/);
  assert.equal(h.get('auto-connect').disabled, false); assert.equal(h.get('auto-connect-guide').hidden, false);
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(requests, 1); assert.match(h.get('auto-connect-hint').textContent, /暂未开启/);
  assert.equal(h.calls.some(call => call.type === 'CONNECT'), false);
});

test('授权通过后主动重连清除旧失败，再收起引导并恢复录制入口', async t => {
  const h = await harness(t), permission = deferred();
  chrome.permissions = { request: () => permission.promise };
  h.update({ connected: false, needsActivation: true, connection: { status: 'error', error: '旧权限错误' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  const pending = h.get('auto-connect').onclick(); await tick();
  assert.match(h.get('auto-connect').textContent, /Chrome/); assert.equal(h.get('auto-connect').disabled, true);
  h.update({ connected: true, needsActivation: false, autoConnectEnabled: true, connection: { status: 'connected' } });
  permission.resolve(true); await pending;
  assert.equal(h.calls.some(call => call.type === 'CONNECT'), true);
  assert.equal(h.get('auto-connect-guide').hidden, true); assert.equal(h.get('error').hidden, true);
  assert.equal(h.get('start').disabled, false); assert.match(h.get('start').innerHTML, /开始录制/);
});

test('手动重连和后台消息的 HOST_ACCESS_REQUIRED 都回到授权引导', async t => {
  const h = await harness(t), send = chrome.runtime.sendMessage;
  h.update({ connected: false, needsActivation: false, autoConnectEnabled: true });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  chrome.runtime.sendMessage = msg => msg.type === 'CONNECT' ? Promise.resolve({ ok: false, code: 'HOST_ACCESS_REQUIRED', error: '需授权' }) : send(msg);
  await h.get('reconnect').onclick();
  assert.equal(h.get('error').hidden, true); assert.equal(h.get('auto-connect-guide').hidden, false);
  assert.match(h.get('connection-label').textContent, /等待授权/);
  h.send({ type: 'ERROR', windowId: 4, code: 'HOST_ACCESS_REQUIRED', error: '需授权', detail: 'native error' });
  assert.equal(h.get('error').hidden, true);
});

test('已授权的连接异常、录制授权及本地文件限制仍展示真实错误', async t => {
  const h = await harness(t);
  h.update({ connected: false, needsActivation: false, autoConnectEnabled: true,
    connection: { status: 'error', error: '标注加载失败', detail: '[initialize] broken script' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('error').hidden, false); assert.match(h.get('error-detail').textContent, /broken script/);
  assert.equal(h.get('auto-connect-guide').hidden, true);
  for (const code of ['CAPTURE_ACTIVATION_REQUIRED', 'FILE_ACCESS_REQUIRED']) {
    h.send({ type: 'ERROR', windowId: 4, code, error: code });
    assert.equal(h.get('error').hidden, false); assert.equal(h.get('error').textContent, code);
  }
});

test('侧栏连接响应挂起有超时，重试后按钮和开始录制可以恢复', async t => {
  const h = await harness(t); const send = chrome.runtime.sendMessage;
  const timers = new Map(); let next = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  chrome.runtime.sendMessage = msg => msg.type === 'CONNECT' ? new Promise(() => {}) : send(msg);
  const pending = h.get('reconnect').onclick(); await tick();
  [...timers.values()].find(timer => timer.ms === 15000).fn(); await pending;
  assert.match(h.get('error').textContent, /暂未响应/); assert.equal(h.get('reconnect').disabled, false);
  assert.match(h.get('connection-label').textContent, /失败.*重试/);
  chrome.runtime.sendMessage = send; await h.get('reconnect').onclick();
  assert.equal(h.get('start').disabled, false); assert.equal(timers.size, 0);
});

test('网页标题与地址未获授权时显示可操作状态，失败和空标签结果不再停留等待连接', async t => {
  const h = await harness(t);
  h.update({ connected: false, needsActivation: true, targetTab: { id: 8, windowId: 4 } });
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  assert.equal(h.get('page-title').textContent, '当前网页待授权');
  assert.match(h.get('page-host').textContent, /开启自动连接/);
  assert.equal(h.get('start').disabled, true); assert.equal(h.get('reconnect').disabled, false);
  h.update({ needsActivation: false, connection: { status: 'error', error: '拒绝连接' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.match(h.get('connection-label').textContent, /连接失败.*重试/);
  h.update({ connected: true, connection: null, targetTab: { id: 8, windowId: 4, url: 'https://demo.example/project' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('page-title').textContent, 'demo.example');
  h.update({ connected: false, targetTab: null }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('page-title').textContent, '未找到当前网页');
  assert.match(h.get('page-host').textContent, /切回要录制的网页/);
});

test('当前网页待授权时保留明确授权入口，即使已有自动连接标记也不隐藏补救操作', async t => {
  const h = await harness(t);
  h.update({ autoConnectEnabled: true, needsActivation: true, connected: false, targetTab: { id: 8, windowId: 4 } });
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  assert.equal(h.get('auto-connect').hidden, false); assert.equal(h.get('auto-connect-hint').hidden, false);
  assert.match(h.get('connection-label').textContent, /等待授权.*开启/);
  assert.match(h.get('auto-connect-hint').textContent, /Chrome.*允许/);
  h.update({ needsActivation: false, connected: true });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('auto-connect').hidden, true);
});

test('手动获取期间状态事件不能重新启用按钮或重复连接，也不能开始录制', async t => {
  const h = await harness(t), gate = deferred(), send = chrome.runtime.sendMessage;
  let requests = 0;
  chrome.runtime.sendMessage = msg => { if (msg.type === 'CONNECT') { requests++; return gate.promise; } return send(msg); };
  const pending = h.get('reconnect').onclick(); await tick();
  assert.match(h.get('connection-label').textContent, /正在获取/);
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('reconnect').disabled, true); assert.equal(h.get('start').disabled, true);
  await h.get('reconnect').onclick(); await h.get('start').onclick();
  assert.equal(requests, 1); assert.notEqual(h.get('range-dialog').open, true);
  gate.resolve({ ok: true }); await pending;
  assert.equal(h.get('reconnect').disabled, false); assert.equal(h.get('start').disabled, false);
  assert.match(h.get('connection-label').textContent, /已连接当前网页/);
});

test('录制、暂停或保存期间刷新入口不能改变采集目标，暂停和停止继续可用', async t => {
  const h = await harness(t);
  for (const status of ['preparing', 'recording', 'paused', 'saving']) {
    h.update({ recording: { status, sessionId: 'capture', tabId: 7 } });
    h.send({ type: 'REFRESH', windowId: 4 }); await tick(); h.calls.length = 0;
    assert.equal(h.get('reconnect').disabled, true); await h.get('reconnect').onclick();
    assert.equal(h.calls.some(call => call.type === 'CONNECT'), false);
    assert.equal(h.get('stop').hidden, false);
    if (status === 'recording' || status === 'paused') assert.equal(h.get('pause').hidden, false);
  }
});

test('侧栏不可见时不因切换网页发起连接，恢复可见后才刷新', async t => {
  const h = await harness(t);
  document.hidden = true; h.documentHandlers.visibilitychange(); h.calls.length = 0;
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  assert.equal(h.calls.some(call => call.type === 'GET_STATE'), false);
  document.hidden = false; h.documentHandlers.visibilitychange(); await tick();
  assert.equal(h.calls.filter(call => call.type === 'GET_STATE').length, 1);
});

test('侧栏直接订阅自己窗口的激活事件，不依赖 worker 广播；两条通知不重复查询', async t => {
  const h = await harness(t, { tabEvents: true });
  h.update({ targetTab: { id: 8, windowId: 4, title: 'new page' } });
  h.activate({ windowId: 12, tabId: 9 }); await tick(); assert.equal(h.calls.length, 0);
  h.activate({ windowId: 4, tabId: 8 }); await tick();
  assert.equal(h.get('page-title').textContent, 'new page');
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8, reason: 'tab-activated' }); await tick();
  assert.equal(h.calls.filter(call => call.type === 'GET_STATE').length, 1);
  assert.equal(h.get('page-title').textContent, 'new page');
});

test('侧栏在当前页地址就绪时连接，不等完全载入；忽略后台页和已连接页的音量等无关变化', async t => {
  const h = await harness(t, { tabEvents: true });
  h.update({ pageLoading: true, connected: false, connection: { status: 'loading' }, targetTab: { id: 8, windowId: 4 } });
  h.activate({ windowId: 4, tabId: 8 }); await tick();
  assert.match(h.get('connection-label').textContent, /加载.*自动连接/);
  h.calls.length = 0;
  h.updateTab(9, { status: 'complete' }, { id: 9, windowId: 4, active: false }); await tick();
  assert.equal(h.calls.length, 0);
  h.update({ pageLoading: false, connected: true, targetTab: { id: 8, windowId: 4, title: 'ready' } });
  h.updateTab(8, { url: 'https://ready.example/' }, { id: 8, windowId: 4, active: true }); await tick();
  assert.equal(h.get('page-title').textContent, 'ready'); assert.equal(h.get('start').disabled, false);
  h.calls.length = 0; h.updateTab(8, { audible: true }, { id: 8, windowId: 4, active: true }); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.intervals.size, 0);
});

test('窗口重新获得焦点能补上遗漏事件，隐藏和关闭侧栏时不查询且释放订阅', async t => {
  const h = await harness(t, { tabEvents: true });
  h.update({ targetTab: { id: 8, windowId: 4, title: 'focused page' } });
  h.windowHandlers.focus?.(); await tick(); assert.equal(h.get('page-title').textContent, 'focused page');
  document.hidden = true; h.calls.length = 0;
  h.activate({ windowId: 4, tabId: 7 }); h.windowHandlers.focus?.(); await tick();
  assert.equal(h.calls.length, 0);
  h.windowHandlers.pagehide();
  assert.equal(h.tabEvents.activated.size, 0); assert.equal(h.tabEvents.updated.size, 0);
});

test('快速切页时旧连接结果晚到不能把侧栏切回原网页', async t => {
  const h = await harness(t, { tabEvents: true }), oldPage = deferred(), send = chrome.runtime.sendMessage;
  let first = true;
  chrome.runtime.sendMessage = message => {
    if (message.type === 'GET_STATE' && first) { first = false; return oldPage.promise; }
    return send(message);
  };
  h.activate({ windowId: 4, tabId: 7 }); await tick();
  h.update({ targetTab: { id: 8, windowId: 4, title: 'latest page' } });
  h.activate({ windowId: 4, tabId: 8 }); await tick();
  assert.equal(h.get('page-title').textContent, 'latest page');
  oldPage.resolve({ ok: true, connected: true, targetTab: { id: 7, title: 'late old page' } }); await tick();
  assert.equal(h.get('page-title').textContent, 'latest page');
});

test('后台状态查询挂起时清除侧栏识别中提示，重试后恢复正常', async t => {
  const h = await harness(t), timers = new Map(); let next = 0;
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  const send = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = msg => msg.type === 'GET_STATE' ? new Promise(() => {}) : send(msg);
  h.send({ type: 'REFRESH', windowId: 4, tabId: 8 }); await tick();
  [...timers.values()].find(timer => timer.ms === 20000).fn(); await tick();
  assert.match(h.get('connection-label').textContent, /未完成.*重试/);
  assert.equal(h.get('start').disabled, true); assert.equal(h.get('reconnect').disabled, false);
  chrome.runtime.sendMessage = send; await h.get('reconnect').onclick();
  assert.equal(h.get('start').disabled, false); assert.equal(timers.size, 0);
});

test('选择或处理图片期间换网页、结束录制时，不把图片加到其他页面或已结束录制', async t => {
  for (const change of ['tab', 'end']) {
    const image = deferred(), h = await harness(t, { prepareImage: () => image.promise });
    h.update({ recording: { status: 'recording', sessionId: 'first' } }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
    h.get('add-image').onclick(); h.get('image-file').files = [{}];
    const pending = h.get('image-file').onchange(); await tick();
    assert.equal(h.get('add-image').disabled, true); assert.equal(h.get('stop').hidden, false);
    if (change === 'tab') h.update({ targetTab: { id: 8, windowId: 4, url: 'https://example.test/other' } });
    else h.update({ recording: { status: 'complete', sessionId: 'first' } });
    h.send({ type: 'REFRESH', windowId: 4 }); await tick();
    image.resolve({ src: 'data:image/png;base64,aGVsbG8=' }); await pending;
    assert.equal(h.calls.some(c => c.command === 'INSERT_IMAGE'), false);
    assert.match(h.get('error').textContent, /状态已变化/); assert.equal(h.get('add-image').disabled, false);
  }
});

test('图片读取失败后恢复按钮并显示错误，不影响录制控制', async t => {
  const h = await harness(t, { prepareImage: async () => { throw new Error('图片无法读取'); } });
  h.get('add-image').onclick(); h.get('image-file').files = [{}]; await h.get('image-file').onchange();
  assert.match(h.get('error').textContent, /图片无法读取/); assert.equal(h.get('add-image').disabled, false); assert.equal(h.get('start').disabled, false);
});

test('开始按钮只打开范围选择，选完整网页才直接启动', async t => {
  const h = await harness(t); await h.get('start').onclick();
  assert.equal(h.get('range-dialog').open, true);
  assert.equal(h.calls.some(c => c.type === 'START'), false);
  await h.get('record-full').onclick();
  assert.equal(h.get('range-dialog').open, false);
  assert.equal(h.calls.filter(c => c.type === 'START').length, 1);
  assert.equal(h.calls.find(c => c.type === 'START').options.range, 'full');
});

test('开始录制先终止试听，独立传入音乐设置；音乐控制绑定当前录制会话', async t => {
  const prepared = deferred(), music = { id: 'song', volume: .2, loop: true };
  const h = await harness(t, { beforeMusic: () => prepared.promise });
  await h.get('start').onclick(); const pending = h.get('record-full').onclick(); await tick();
  assert.equal(h.calls.some(call => call.type === 'START'), false);
  prepared.resolve(music); await pending;
  assert.deepEqual(h.calls.find(call => call.type === 'START').options.music, music);
  await h.musicControls.send('pause', undefined, 'active-song-session');
  assert.equal(h.calls.at(-1).sessionId, 'active-song-session'); assert.equal(h.calls.at(-1).type, 'MUSIC');
});

test('收藏音乐时禁止开始和并行图片准备，但暂停结束录制控制不受影响', async t => {
  const h = await harness(t); h.musicControls.onBusy(true);
  assert.equal(h.get('start').disabled, true); assert.equal(h.materialControls.canImport(), false);
  h.musicControls.onBusy(false); assert.equal(h.get('start').disabled, false);
  h.update({ recording: { status: 'recording', sessionId: 'active' } }); h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.musicControls.canImport(), false); assert.equal(h.get('stop').hidden, false); assert.equal(h.get('pause').hidden, false);
});

test('框选等待期间不录制，收到选区后只自动启动一次', async t => {
  const h = await harness(t); await h.get('start').onclick(); await h.get('record-region').onclick();
  assert.equal(h.calls.some(c => c.type === 'START'), false);
  assert.equal(h.get('start').hidden, true);
  const crop = { x: 0, y: 0, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  const selectionId = h.calls.find(c => c.command === 'CROP').options.selectionId;
  h.send({ type: 'CROP_READY', crop, selectionId }); h.send({ type: 'CROP_READY', crop, selectionId }); await tick();
  assert.equal(h.calls.filter(c => c.type === 'START').length, 1);
  assert.equal(h.calls.find(c => c.type === 'START').options.range, 'region');
});

test('重新框选后忽略上一轮迟到的选区和取消消息', async t => {
  const h = await harness(t); await h.get('start').onclick(); await h.get('record-region').onclick();
  const old = h.calls.find(c => c.command === 'CROP').options.selectionId;
  await h.get('stop').onclick(); await h.get('start').onclick(); await h.get('record-region').onclick();
  const current = h.calls.filter(c => c.command === 'CROP').at(-1).options.selectionId;
  const crop = { width: .5, height: .5, viewportWidth: 1000, viewportHeight: 800 };
  h.send({ type: 'CROP_READY', crop, selectionId: old }); h.send({ type: 'CROP_CANCEL', selectionId: old }); await tick();
  assert.equal(h.calls.some(c => c.type === 'START'), false);
  assert.equal(h.get('stop').textContent, '取消框选');
  h.send({ type: 'CROP_READY', crop, selectionId: current }); await tick();
  assert.equal(h.calls.filter(c => c.type === 'START').length, 1);
  assert.equal(h.calls.find(c => c.type === 'START').selectionId, current);
});

test('连接中保留取消按钮，主动取消状态恢复可开始', async t => {
  const h = await harness(t);
  h.send({ type: 'STATE', state: { status: 'preparing' } });
  assert.equal(h.get('stop').hidden, false);
  assert.equal(h.get('stop').textContent, '取消连接');
  await h.get('stop').onclick();
  assert.equal(h.calls.some(c => c.type === 'STOP'), true);
  h.send({ type: 'STATE', state: { status: 'cancelled', released: true } }); await tick();
  assert.equal(h.get('start').disabled, false);
});

test('取消框选后迟到的选区事件不会启动录制', async t => {
  const h = await harness(t); await h.get('start').onclick(); await h.get('record-region').onclick();
  await h.get('stop').onclick();
  h.send({ type: 'CROP_READY', crop: {} }); await tick();
  assert.equal(h.calls.some(c => c.type === 'START'), false);
  assert.equal(h.calls.some(c => c.command === 'CANCEL_CROP'), true);
  assert.equal(h.get('start').disabled, false);
});

test('侧栏请求携带所属窗口与已显示目标，不采用最后聚焦窗口', async t => {
  const h = await harness(t, { windowId: 12 });
  await h.get('start').onclick(); await h.get('record-full').onclick();
  const request = h.calls.find(message => message.type === 'START');
  assert.equal(request.windowId, 12); assert.equal(request.tabId, 7);
  assert.equal(h.calls.filter(message => message.type === 'GET_STATE').every(message => message.windowId === 12), true);
});

test('另一窗口刷新不改变本侧栏，当前窗口切换标签会关闭范围对话框', async t => {
  const h = await harness(t); await h.get('start').onclick();
  h.calls.length = 0;
  h.send({ type: 'REFRESH', windowId: 99 }); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.get('range-dialog').open, true);
  h.update({ targetTab: { id: 8, windowId: 4, title: 'second', url: 'https://second.test' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('range-dialog').open, false);
  assert.equal(h.get('page-title').textContent, 'second');
  assert.equal(h.calls.some(message => message.type === 'START'), false);
});

test('切换网页只取消旧网页本轮框选，迟到结果不能启动新网页录制', async t => {
  const h = await harness(t); await h.get('start').onclick(); await h.get('record-region').onclick();
  const id = h.calls.find(message => message.command === 'CROP').options.selectionId;
  h.update({ targetTab: { id: 8, windowId: 4, title: 'second', url: 'https://second.test' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  const cancel = h.calls.find(message => message.command === 'CANCEL_CROP');
  assert.equal(cancel.tabId, 7); assert.equal(cancel.windowId, 4); assert.equal(cancel.options.selectionId, id);
  h.send({ type: 'CROP_READY', tabId: 7, selectionId: id, crop: { width: .5, height: .5 } }); await tick();
  assert.equal(h.calls.some(message => message.type === 'START'), false);
  assert.equal(h.get('start').hidden, false); assert.equal(h.get('start').disabled, false);
});

test('未授权网页禁用录制和标注，并提示一次开启自动连接', async t => {
  const h = await harness(t);
  h.update({ connected: false, needsActivation: true, targetTab: { id: 8, windowId: 4 } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('start').disabled, true); assert.equal(h.get('tool-rect').disabled, true);
  assert.match(h.get('connection-label').textContent, /等待授权.*开启/);
  assert.equal(h.get('auto-connect').hidden, false);
});

test('录制期间切到其他网页保留暂停结束，但禁用标注且说明原页锁定', async t => {
  const h = await harness(t);
  h.update({ recording: { status: 'recording', tabId: 7 }, connected: false, isCurrentTab: false });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('pause').hidden, false); assert.equal(h.get('stop').hidden, false);
  assert.equal(h.get('tool-rect').disabled, true);
  assert.match(h.get('connection-label').textContent, /录制仍锁定原网页/);
  await h.get('stop').onclick();
  assert.equal(h.calls.find(message => message.type === 'STOP').tabId, 7);
});

test('窗口识别失败不向后台猜测窗口，明确提示重新打开侧栏', async t => {
  const h = await harness(t, { getCurrent: async () => { throw new Error('window unavailable'); } });
  assert.equal(h.calls.length, 0); assert.equal(h.get('start').disabled, true);
  assert.match(h.get('error').textContent, /无法确定侧栏所属窗口/);
  assert.equal(h.get('reconnect').disabled, true);
});

test('点击开始时才发现当前页变化，也能一次打开新页面范围选择', async t => {
  const h = await harness(t);
  h.update({ targetTab: { id: 8, windowId: 4, title: 'second', url: 'https://second.test' } });
  await h.get('start').onclick();
  assert.equal(h.get('range-dialog').open, true);
  await h.get('record-full').onclick();
  assert.equal(h.calls.find(message => message.type === 'START').tabId, 8);
});

test('另一网页旧错误状态刷新后不会继续留在当前侧栏', async t => {
  const h = await harness(t);
  h.send({ type: 'STATE', state: { status: 'error', tabId: 20, error: '另一页的旧错误' } });
  await tick();
  assert.equal(h.get('error').hidden, true);
  assert.equal(h.get('error').textContent, '');
});

test('旧测试环境无windows API仍可检查基础流程', async t => {
  const h = await harness(t, { legacyWindows: true });
  await h.get('start').onclick(); await h.get('record-full').onclick();
  assert.equal(h.calls.filter(message => message.type === 'START').length, 1);
});

test('移除录完自动下载入口，旧自动导出设置不影响新录制', async t => {
  const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="autoExport"/); assert.match(html, /id="diagnostics"/);
  assert.doesNotMatch(html, /id="diagnostics"[^>]*checked/);
  const h = await harness(t, { settings: { autoExport: true, diagnostics: false }, storedKeys: { setting_autoExport: true } });
  assert.equal(h.get('diagnostics').checked, false);
  await h.get('start').onclick(); await h.get('record-full').onclick();
  const options = h.calls.find(message => message.type === 'START').options;
  assert.equal(options.autoExport, undefined); assert.equal(options.diagnostics, false);
  assert.equal(h.savedSettings.some(saved => 'setting_autoExport' in saved), false);
});

test('录完仅显示回看入口，由用户点击打开对应成片，开始新录制后收起', async t => {
  const h = await harness(t);
  assert.equal(h.get('review-recording').hidden, true);
  for (const status of ['complete', 'interrupted']) {
    const recording = { status, id: 'saved clip', bytes: 1000 };
    h.update({ recording }); h.send({ type: 'STATE', state: recording }); await tick();
    assert.equal(h.get('review-recording').hidden, false);
    assert.equal(h.openedPages.length, 0);
  }
  h.get('review-recording').onclick();
  assert.deepEqual(h.openedPages, [{ url: 'chrome-extension://test/library.html?id=saved%20clip' }]);
  h.send({ type: 'STATE', state: { status: 'preparing', id: 'new' } });
  assert.equal(h.get('review-recording').hidden, true);
});

test('暂停继续停止携带当前会话，保存期间保留强制结束入口', async t => {
  const h = await harness(t);
  for (const [status, type, button] of [['recording', 'PAUSE', 'pause'], ['paused', 'RESUME', 'pause'], ['recording', 'STOP', 'stop'], ['saving', 'FORCE_STOP', 'stop']]) {
    h.send({ type: 'STATE', state: { status, sessionId: 'current-session', id: 'recording-1' } });
    if (status === 'saving') { assert.equal(h.get('stop').hidden, false); assert.equal(h.get('stop').textContent, '强制结束'); }
    await h.get(button).onclick();
    assert.equal(h.calls.at(-1).type, type); assert.equal(h.calls.at(-1).sessionId, 'current-session');
  }
});

test('导出提示与主录制状态分开，旧录制导出消息不覆盖当前录制提示', async t => {
  const h = await harness(t);
  h.send({ type: 'STATE', state: { status: 'recording', sessionId: 'current', id: 'recording-1' } });
  const before = [...h.get('status-label').children];
  h.send({ type: 'EXPORT_STATE', recordingId: 'recording-1', export: { status: 'error' } });
  assert.match(h.get('export-notice').textContent, /导出失败.*录制库重试/);
  assert.deepEqual(h.get('status-label').children, before);
  h.send({ type: 'EXPORT_STATE', recordingId: 'older', export: { status: 'complete' } });
  assert.match(h.get('export-notice').textContent, /导出失败/);
  h.send({ type: 'EXPORT_STATE', recordingId: 'recording-1', export: { status: 'complete' } });
  assert.match(h.get('export-notice').textContent, /已导出/);
});

test('跨窗口设置变更同步到表单，修改帧率只保存该字段', async t => {
  const h = await harness(t);
  h.storageChange({ setting_diagnostics: { newValue: false }, setting_autoExport: { newValue: false } });
  assert.equal(h.get('diagnostics').checked, false);
  h.get('fps').value = '60'; h.get('fps').handlers.change(); await tick();
  assert.deepEqual(h.savedSettings.at(-1), { setting_fps: '60' });
});

test('一键低负载只保存画质和20FPS，开始录制实际使用该设置', async t => {
  const h = await harness(t);
  await h.get('low-load').onclick();
  assert.equal(h.get('quality').value, 'performance'); assert.equal(h.get('fps').value, '20');
  assert.deepEqual(h.savedSettings, [{ setting_quality: 'performance' }, { setting_fps: '20' }]);
  await h.get('start').onclick(); await h.get('record-full').onclick();
  const options = h.calls.find(message => message.type === 'START').options;
  assert.equal(options.quality, 'performance'); assert.equal(options.fps, 20);
  h.send({ type: 'STATE', state: { status: 'recording' } });
  const count = h.savedSettings.length; await h.get('low-load').onclick();
  assert.equal(h.savedSettings.length, count);
});

test('重新打开后刷新完成录制会补查导出状态，支持取消导出', async t => {
  const h = await harness(t, { exportState: { status: 'downloading', progress: { percent: 52 } } });
  h.update({ recording: { status: 'complete', id: 'saved-video' } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.match(h.get('export-notice').textContent, /52%/);
  assert.equal(h.get('cancel-export').hidden, false);
  await h.get('cancel-export').onclick();
  assert.equal(h.calls.at(-1).type, 'EXPORT_CANCEL'); assert.equal(h.calls.at(-1).recordingId, 'saved-video');
});

test('受支持的 MP4 设置实际传入 START，新存储值优先旧设置', async t => {
  const h = await harness(t, { settings: { format: 'webm' }, storedKeys: { setting_format: 'mp4' } });
  assert.equal(h.get('format').value, 'mp4');
  await h.get('start').onclick(); await h.get('record-full').onclick();
  assert.equal(h.calls.find(message => message.type === 'START').options.format, 'mp4');
});

test('不支持 MP4 的浏览器禁用选项并回退可用 WebM', async t => {
  const h = await harness(t, { mp4Supported: false, storedKeys: { setting_format: 'mp4' } });
  assert.equal(h.get('format-mp4').disabled, true); assert.equal(h.get('format').value, 'webm');
  assert.match(h.get('format-hint').textContent, /暂不支持/);
});

test('麦克风拒绝授权会把最终关闭状态写回独立设置', async t => {
  const h = await harness(t);
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new Error('permission denied'); } } });
  t.after(() => previous ? Object.defineProperty(navigator, 'mediaDevices', previous) : delete navigator.mediaDevices);
  const permission = h.get('microphone').onchange();
  h.get('microphone').handlers.change();
  await permission; await tick();
  assert.equal(h.get('microphone').checked, false);
  assert.deepEqual(h.savedSettings.at(-1), { setting_microphone: false });
  assert.match(h.get('error').textContent, /麦克风授权页/);
});

test('初始设置延迟时 REFRESH 和手动重连不能提前启用开始，重连复用同一读取', async t => {
  const settings = deferred(); let reads = 0;
  const h = await harness(t, { getSettings: () => { reads++; return settings.promise; } });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('start').disabled, true);
  await h.get('start').onclick(); assert.notEqual(h.get('range-dialog').open, true);
  const reconnect = h.get('reconnect').onclick(); await tick();
  assert.equal(reads, 1); assert.equal(h.calls.some(message => message.type === 'CONNECT'), false);
  settings.resolve({ setting_format: 'mp4', setting_autoExport: false, setting_diagnostics: false, setting_audio: false });
  await reconnect; await tick();
  assert.equal(h.get('start').disabled, false);
  await h.get('start').onclick(); await h.get('record-full').onclick();
  const options = h.calls.find(message => message.type === 'START').options;
  assert.equal(options.format, 'mp4'); assert.equal(options.autoExport, undefined);
  assert.equal(options.diagnostics, false); assert.equal(options.audio, false);
});

test('开始请求自身也等待初始设置，迟到读取不会覆盖等待期间的新设置', async t => {
  const settings = deferred();
  const h = await harness(t, { getSettings: () => settings.promise });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  const starting = h.get('record-full').onclick(); await tick();
  assert.equal(h.calls.some(message => message.type === 'START'), false);
  h.storageChange({ setting_format: { newValue: 'mp4' } });
  settings.resolve({ setting_format: 'webm', setting_autoExport: false });
  await starting; await tick();
  const options = h.calls.find(message => message.type === 'START').options;
  assert.equal(options.format, 'mp4'); assert.equal(options.autoExport, undefined);
});

test('初始化收尾不得取消本面板已开启的新一轮框选', async t => {
  const settings = deferred();
  const h = await harness(t, { getSettings: () => settings.promise });
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  // Simulate a range-choice event already queued when initialization completes.
  await h.get('record-region').onclick();
  const selectionId = h.calls.find(message => message.command === 'CROP').options.selectionId;
  h.update({ overlay: { cropMode: true, selectionId } });
  settings.resolve({}); await tick();
  assert.equal(h.calls.some(message => message.command === 'CANCEL_CROP'), false);
  assert.equal(h.get('stop').textContent, '取消框选');
  await h.get('stop').onclick();
  assert.equal(h.calls.at(-1).command, 'CANCEL_CROP');
  assert.equal(h.calls.at(-1).options.selectionId, selectionId);
});

test('设置读取失败明确提示并保持禁录，重新连接可重新读取后恢复', async t => {
  let reads = 0;
  const h = await harness(t, { getSettings: async () => {
    if (++reads === 1) throw new Error('storage unavailable');
    return { setting_diagnostics: false };
  } });
  assert.equal(h.get('start').disabled, true);
  assert.match(h.get('error').textContent, /读取录制设置失败.*重新连接/);
  assert.match(h.get('error-detail').textContent, /storage unavailable/);
  h.send({ type: 'REFRESH', windowId: 4 }); await tick();
  assert.equal(h.get('start').disabled, true);
  assert.match(h.get('error').textContent, /读取录制设置失败/);
  await h.get('reconnect').onclick();
  assert.equal(reads, 2); assert.equal(h.get('start').disabled, false);
  assert.equal(h.get('error').hidden, true); assert.equal(h.get('diagnostics').checked, false);
});

test('设置读取超时后可重试，旧请求迟到不会覆盖恢复后的选项', async t => {
  const stalled = deferred(); let timeout, reads = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => { if (ms === 5000) timeout = callback; return 0; });
  const h = await harness(t, { getSettings: () => ++reads === 1 ? stalled.promise : Promise.resolve({ setting_format: 'mp4' }) });
  timeout(); await tick();
  assert.equal(h.get('start').disabled, true); assert.match(h.get('error-detail').textContent, /超时/);
  await h.get('reconnect').onclick();
  assert.equal(h.get('format').value, 'mp4'); assert.equal(h.get('start').disabled, false);
  stalled.resolve({ setting_format: 'webm' }); await tick();
  assert.equal(h.get('format').value, 'mp4');
});
