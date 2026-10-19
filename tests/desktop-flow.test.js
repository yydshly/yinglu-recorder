import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chooseRecordingMime, isRecordingFormatSupported } from '../lib/media-format.js';
const source = await readFile(new URL('../desktop.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function harness(t, { settings = {}, storedKeys = {}, mp4Supported = true } = {}) {
  const elements = new Map(), calls = [], starts = [], listeners = {}, intervals = [], activeIntervals = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: ({ fps: '30', quality: '1080', format: 'webm' })[id] || '', checked: id === 'audio', hidden: true,
      style: {}, textContent: '', pause() { this.paused = true; }, async play() { this.paused = false; }, videoWidth: 1280, videoHeight: 720,
      replaceChildren(...children) { this.children = children; }, getContext: () => ({ fillRect() {}, clearRect() {}, strokeRect() {} }) });
    return elements.get(id);
  };
  const track = kind => ({ kind, label: '演示来源', readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener(name, fn) { this[name] = fn; } });
  class Stream {
    constructor(tracks = [track('video'), track('audio')]) { this.tracks = tracks; }
    get active() { return this.tracks.some(t => t.readyState === 'live'); }
    getTracks() { return this.tracks; } getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  }
  const h = { get, calls, starts, listeners, intervals, activeIntervals, Stream, picked: new Stream(), acquire: undefined, preparing: false, settings, savedSettings: [], controls: [] };
  class Recorder {
    constructor(callback) { this.callback = callback; this.state = { status: 'idle' }; h.recorder = this; }
    publish(state) { this.state = { ...this.state, ...state }; this.callback(this.state); }
    async start(stream, options) {
      starts.push({ stream, options }); this.publish({ status: 'preparing', ...options.context });
      if (h.preparing) { h.startGate = deferred(); await h.startGate.promise; }
      else this.publish({ status: 'recording', id: 'video-1' });
    }
    stop() {
      h.controls.push('stop');
      if (this.state.status !== 'preparing') return;
      this.publish({ status: 'cancelled', duration: 0, released: true });
      h.startGate?.reject(new DOMException('已取消', 'AbortError'));
    }
    pause() { h.controls.push('pause'); this.publish({ status: 'paused' }); }
    resume() { h.controls.push('resume'); this.publish({ status: 'recording' }); }
  }
  const values = { document: h.document = { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; }, getElementById: get, createElement: tag => ({ tag }) },
    chrome: { runtime: { id: 'test', onMessage: { addListener: listener => { h.notify = listener; } }, sendMessage: async message => { calls.push(message); if (message.type === 'DESKTOP_ACQUIRE' && h.acquire) return h.acquire.promise; if (message.type === 'DESKTOP_PREVIEW_ACQUIRE' && h.previewError) return { ok: false, error: h.previewError }; if (message.type === 'GET_EXPORT_STATE') return { ok: true, export: h.exportState }; if (message.type === 'EXPORT_CANCEL') return { ok: true, export: { status: 'cancelled' } }; return { ok: true }; } }, tabs: { getCurrent: async () => ({ id: 17 }) },
      storage: { onChanged: { addListener: fn => { h.storageChange = fn; } }, local: { get: async () => ({ settings: h.settings, ...storedKeys }), set: async value => { h.savedSettings.push(value); Object.assign(storedKeys, value); } } } },
    navigator: { mediaDevices: { getDisplayMedia: async () => { if (h.pickError) throw h.pickError; return h.picked; } } },
    MediaStream: Stream, MediaRecorder: { isTypeSupported: mime => !mime.startsWith('video/mp4') || mp4Supported }, addEventListener: (type, fn) => { listeners[type] = fn; },
    setInterval: (fn, ms) => { intervals.push(fn); activeIntervals.set(intervals.length, { fn, ms }); return intervals.length; }, clearInterval: id => activeIntervals.delete(id),
    desktopTest: { Recorder, chooseRecordingMime, isRecordingFormatSupported, clockText: value => String(value), elapsed: () => 999999, normalizeRect: () => ({}) } };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const code = 'const { Recorder, chooseRecordingMime, isRecordingFormatSupported, clockText, elapsed, normalizeRect } = globalThis.desktopTest;\n' + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  return h;
}

test('桌面开始先领取全局会话，关闭来源声音后不会继续录入来源音轨', async t => {
  const h = await harness(t); await h.get('choose').onclick(); h.get('audio').checked = false;
  await h.get('start').onclick(); await tick();
  const preview = h.calls.find(call => call.type === 'DESKTOP_PREVIEW_ACQUIRE');
  assert.equal(h.calls[0].type, 'DESKTOP_READY'); assert.ok(preview);
  assert.equal(h.calls.every(call => call.tabId === 17), true);
  assert.equal(h.calls.find(call => call.type === 'DESKTOP_ACQUIRE').sessionId, preview.sessionId);
  assert.equal(h.starts[0].stream.getAudioTracks().length, 0);
  assert.equal(h.picked.getAudioTracks()[0].readyState, 'ended');
  assert.equal(h.starts[0].options.context.ownerTabId, 17);
  assert.equal(h.starts[0].options.context.sessionId, preview.sessionId);
  assert.equal(h.get('source').srcObject, null); assert.equal(h.get('stage').hidden, true);
});

test('等待全局会话时可以取消，迟到的授权不会再开始录制', async t => {
  const h = await harness(t); await h.get('choose').onclick(); h.acquire = deferred();
  const pending = h.get('start').onclick(); await tick();
  assert.equal(h.get('stop').hidden, false); assert.equal(h.get('stop').textContent, '取消准备');
  h.get('stop').onclick(); assert.equal(h.get('choose').disabled, false);
  h.acquire.resolve({ ok: true }); await pending;
  assert.equal(h.starts.length, 0); assert.equal(h.calls.at(-1).type, 'DESKTOP_RELEASE');
  assert.equal(h.picked.getTracks().every(track => track.readyState === 'ended'), true);
});

test('连接画面阶段取消会释放会话、恢复选择入口且不显示错误', async t => {
  const h = await harness(t); await h.get('choose').onclick(); h.preparing = true;
  const pending = h.get('start').onclick(); await tick(); h.get('stop').onclick(); await pending;
  assert.equal(h.recorder.state.status, 'cancelled'); assert.equal(h.get('status').textContent, '已取消');
  assert.equal(h.get('choose').disabled, false); assert.equal(h.get('error').hidden, true);
  assert.equal(h.calls.at(-1).type, 'DESKTOP_RELEASE');
});

test('来源未共享声音时明确要求重选或关闭声音，不能悄悄无声开始', async t => {
  const h = await harness(t); h.picked = new h.Stream(h.picked.getVideoTracks()); await h.get('choose').onclick();
  await h.get('start').onclick();
  assert.equal(h.starts.length, 0); assert.equal(h.calls.some(call => call.type === 'DESKTOP_ACQUIRE'), false);
  assert.match(h.get('error').textContent, /重新选择来源/);
});

test('取消重选来源会保留原预览，中断计时使用已保存时长', async t => {
  const h = await harness(t); await h.get('choose').onclick(); h.pickError = new DOMException('cancelled', 'NotAllowedError');
  await h.get('choose').onclick(); assert.equal(h.picked.active, true); assert.equal(h.get('source').srcObject, h.picked);
  h.recorder.publish({ status: 'interrupted', id: 'partial', duration: 4200, released: true });
  assert.equal(h.get('timer').textContent, '4200'); assert.equal(h.get('status').textContent, '部分保存');
});

test('桌面移除自动导出，旧开启设置不会进入新录制，完成后可回看录制', async t => {
  const html = await readFile(new URL('../desktop.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /autoExport|录完自动导出/); assert.doesNotMatch(source, /autoExport/);
  assert.match(html, /本地录制库.*回看并选择下载/);
  const h = await harness(t, { settings: { autoExport: true, diagnostics: true }, storedKeys: { setting_autoExport: true } });
  h.storageChange({ setting_autoExport: { newValue: true } }, 'local');
  assert.equal(h.settings.diagnostics, true);
  await h.get('choose').onclick(); await h.get('start').onclick();
  assert.equal(Object.hasOwn(h.starts[0].options.context, 'autoExport'), false);
  h.recorder.publish({ status: 'complete', released: true });
  await tick();
  assert.equal(h.get('result').children[0].textContent, '回看录制 ↗');
  assert.equal(h.get('result').children[0].href, 'library.html?id=video-1');
  assert.equal(h.savedSettings.length, 0);
  assert.equal(h.calls.some(call => call.type === 'RETRY_EXPORT'), false);
});

test('桌面导出消息不改变主录制状态，saving 状态仍能直接强制停止', async t => {
  const h = await harness(t); await h.get('choose').onclick(); await h.get('start').onclick();
  h.get('pause').onclick(); assert.equal(h.controls.at(-1), 'pause');
  h.get('pause').onclick(); assert.equal(h.controls.at(-1), 'resume');
  h.notify({ type: 'EXPORT_STATE', recordingId: 'video-1', export: { status: 'error' } });
  assert.match(h.get('export-notice').textContent, /导出失败.*录制库重试/);
  assert.equal(h.get('status').textContent, '正在录制');
  h.notify({ type: 'EXPORT_STATE', recordingId: 'other', export: { status: 'complete' } });
  assert.match(h.get('export-notice').textContent, /导出失败/);
  h.recorder.publish({ status: 'saving' });
  assert.equal(h.get('stop').hidden, false); assert.equal(h.get('stop').textContent, '强制结束');
  h.get('stop').onclick(); assert.equal(h.controls.at(-1), 'stop');
  await tick();
});

test('预览申请被拒绝时立即停止返回的来源，不留下未受控采集', async t => {
  const h = await harness(t); h.previewError = '已有录制进行中';
  await h.get('choose').onclick();
  assert.equal(h.picked.active, false); assert.equal(h.get('source').srcObject, undefined);
  assert.match(h.get('error').textContent, /已有录制/);
});

test('释放来源和浏览器停止共享都会释放预览锁，离页也会释放', async t => {
  const h = await harness(t); await h.get('choose').onclick();
  const first = h.calls.find(call => call.type === 'DESKTOP_PREVIEW_ACQUIRE').sessionId;
  await h.get('release-source').onclick();
  assert.equal(h.picked.active, false); assert.equal(h.get('start').disabled, true);
  assert.equal(h.calls.at(-1).type, 'DESKTOP_PREVIEW_RELEASE'); assert.equal(h.calls.at(-1).sessionId, first);
  h.picked = new h.Stream(); await h.get('choose').onclick();
  h.picked.getVideoTracks()[0].ended(); await tick();
  assert.equal(h.calls.at(-1).type, 'DESKTOP_PREVIEW_RELEASE');
  h.picked = new h.Stream(); await h.get('choose').onclick();
  h.listeners.pagehide(); await tick();
  assert.equal(h.picked.active, false); assert.equal(h.calls.at(-1).type, 'DESKTOP_PREVIEW_RELEASE');
  assert.equal(h.calls.every(call => call.tabId === 17), true);
});

test('桌面格式仍按字段同步，MP4 传给实际录制选项', async t => {
  const h = await harness(t, { storedKeys: { setting_format: 'webm' } });
  h.storageChange({ setting_format: { newValue: 'mp4' } }, 'local');
  assert.equal(h.get('format').value, 'mp4');
  await h.get('format').onchange(); assert.deepEqual(h.savedSettings.at(-1), { setting_format: 'mp4' });
  await h.get('choose').onclick(); await h.get('start').onclick(); await tick();
  assert.equal(h.starts[0].options.format, 'mp4');
});

test('手动导出状态仍可查询更新进度和取消，不影响已保存录制入口', async t => {
  const h = await harness(t); await h.get('choose').onclick(); await h.get('start').onclick();
  h.exportState = { status: 'preparing', phase: 'converting', percent: 25 };
  h.recorder.publish({ status: 'complete', released: true }); await tick();
  assert.ok(h.calls.some(call => call.type === 'GET_EXPORT_STATE' && call.recordingId === 'video-1'));
  assert.match(h.get('export-notice').textContent, /本机转换.*25%/);
  h.notify({ type: 'EXPORT_STATE', recordingId: 'video-1', export: { status: 'downloading', percent: 70 } });
  assert.match(h.get('export-notice').textContent, /下载.*70%/); assert.equal(h.get('cancel-export').hidden, false);
  await h.get('cancel-export').onclick();
  assert.equal(h.calls.at(-1).type, 'EXPORT_CANCEL'); assert.equal(h.calls.at(-1).recordingId, 'video-1');
  assert.match(h.get('export-notice').textContent, /已取消导出/);
  assert.equal(h.get('result').children[0].textContent, '回看录制 ↗');
});

test('桌面STATUS仅响应后台目标标签，返回同一文档token及当前预览会话', async t => {
  const h = await harness(t); await h.get('choose').onclick();
  const ready = h.calls.find(call => call.type === 'DESKTOP_READY');
  const preview = h.calls.find(call => call.type === 'DESKTOP_PREVIEW_ACQUIRE');
  assert.ok(ready.documentToken); assert.equal(ready.documentToken, preview.documentToken);
  let reply;
  h.notify({ target: 'desktop', type: 'STATUS', tabId: 17 }, { id: 'test' }, value => { reply = value; });
  assert.equal(reply.documentToken, ready.documentToken); assert.equal(reply.sessionId, preview.sessionId);
  assert.equal(reply.state.status, 'idle'); assert.equal(reply.sourceActive, true); assert.equal(reply.closed, false);
  for (const [tabId, sender] of [[18, { id: 'test' }], [17, { id: 'other' }], [17, { id: 'test', tab: { id: 17 } }]]) {
    reply = undefined; h.notify({ target: 'desktop', type: 'STATUS', tabId }, sender, value => { reply = value; });
    assert.equal(reply, undefined);
  }
});

test('桌面STATUS在新准备期间返回新session，即使Recorder仍保留上次终态', async t => {
  const h = await harness(t); h.recorder.publish({ status: 'complete', sessionId: 'previous', id: 'old' });
  await h.get('choose').onclick(); h.acquire = deferred();
  const starting = h.get('start').onclick(); await tick();
  let status; h.notify({ target: 'desktop', type: 'STATUS', tabId: 17 }, { id: 'test' }, value => { status = value; });
  assert.equal(status.state.sessionId, 'previous');
  assert.equal(status.sessionId, h.calls.find(call => call.type === 'DESKTOP_ACQUIRE').sessionId);
  assert.notEqual(status.sessionId, 'previous');
  h.get('stop').onclick(); h.acquire.resolve({ ok: true }); await starting;
});

test('桌面离页后STATUS明确closed，不将旧页面继续当作活跃来源', async t => {
  const h = await harness(t); await h.get('choose').onclick(); h.listeners.pagehide(); await tick();
  let status; h.notify({ target: 'desktop', type: 'STATUS', tabId: 17 }, { id: 'test' }, value => { status = value; });
  assert.equal(status.closed, true); assert.equal(status.sourceActive, false);
});

test('桌面计时仅在可见录制中保持一个秒级任务，暂停、空闲及隐藏均停止', async t => {
  const h = await harness(t);
  assert.equal(h.activeIntervals.size, 0);
  h.recorder.publish({ status: 'preparing' }); assert.equal(h.activeIntervals.size, 0);
  h.recorder.publish({ status: 'recording' }); h.recorder.publish({ status: 'recording' });
  assert.equal(h.activeIntervals.size, 1); assert.equal([...h.activeIntervals.values()][0].ms, 1000);
  h.document.hidden = true; h.listeners.visibilitychange(); assert.equal(h.activeIntervals.size, 0);
  h.document.hidden = false; h.listeners.visibilitychange(); assert.equal(h.activeIntervals.size, 1);
  h.recorder.pause(); assert.equal(h.activeIntervals.size, 0);
  h.recorder.resume(); assert.equal(h.activeIntervals.size, 1);
  h.recorder.publish({ status: 'saving' }); assert.equal(h.activeIntervals.size, 0);
  h.recorder.publish({ status: 'complete', duration: 4000 });
  assert.equal(h.get('timer').textContent, '4000'); assert.equal(h.activeIntervals.size, 0);
});

test('桌面离页清除录制计时，迟到的可见性与状态事件不能重新创建任务', async t => {
  const h = await harness(t); h.recorder.publish({ status: 'recording' });
  h.listeners.pagehide(); assert.equal(h.activeIntervals.size, 0);
  h.listeners.visibilitychange(); h.recorder.publish({ status: 'recording' });
  assert.equal(h.activeIntervals.size, 0);
});
