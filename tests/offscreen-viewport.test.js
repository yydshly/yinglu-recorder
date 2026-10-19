import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../offscreen.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function harness(t) {
  const h = { calls: [], gate: deferred(), track: { readyState: 'live', stop() { this.readyState = 'ended'; } } };
  const stream = { getTracks: () => [h.track] };
  class Recorder {
    constructor() { this.state = { status: 'idle' }; }
    async start(acquire, options) {
      this.controller = new AbortController(); this.state = { status: 'preparing', ...options.context };
      h.options = options;
      h.stream = await acquire(this.controller.signal);
      this.state = { status: 'recording', ...options.context }; h.started = true;
    }
    stop() { this.controller.abort(new DOMException('已取消', 'AbortError')); this.state.status = 'cancelled'; }
  }
  let listener;
  const values = { chrome: { runtime: { sendMessage: async message => { h.calls.push(message); return h.gate.promise; },
    onMessage: { addListener: fn => { listener = fn; } } } },
    navigator: { mediaDevices: { getUserMedia: async constraints => { h.acquired = true; h.constraints = constraints; return stream; } } }, offscreenViewportTest: { Recorder } };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  await import('data:text/javascript;base64,' + Buffer.from(source.replace(/^import .*;\r?\n/, 'const {Recorder} = globalThis.offscreenViewportTest;\n') + '\n//' + Math.random()).toString('base64'));
  h.send = message => new Promise(resolve => listener({ target: 'offscreen', ...message }, {}, resolve));
  h.start = () => h.send({ type: 'START', streamId: 'source', options: { audio: false,
    crop: { x: .1, y: .2, width: .5, height: .5, viewportWidth: 1200, viewportHeight: 800 },
    context: { sessionId: 'session', cropViewport: { viewportWidth: 1200, viewportHeight: 800 }, cropViewportPending: true } } });
  return h;
}

test('真实流取得后才确认 CSS 视口，确认前不向视频管线交流并更新最终裁剪上下文', async t => {
  const h = await harness(t), pending = h.start(); await tick();
  assert.equal(h.acquired, true); assert.equal(h.started, undefined);
  assert.deepEqual(h.calls[0], { target: 'background', type: 'CAPTURE_VIEWPORT_READY', sessionId: 'session' });
  const crop = { x: .12, y: .25, width: .6, height: .625, viewportWidth: 1000, viewportHeight: 640 };
  const cropViewport = { viewportWidth: 1000, viewportHeight: 640 };
  h.gate.resolve({ ok: true, crop, cropViewport });
  assert.equal((await pending).ok, true); assert.equal(h.started, true);
  assert.deepEqual(h.options.crop, crop); assert.deepEqual(h.options.context.cropViewport, cropViewport);
  assert.equal(h.options.context.cropViewportPending, false);
  assert.equal(h.options.captureLayout, 'chrome-tab');
});

test('低负载在首次getUserMedia即限制采集尺寸和20FPS，不先取得大画面', async t => {
  const h = await harness(t);
  const response = await h.send({ type: 'START', streamId: 'low-load', options: { quality: 'performance', fps: 20, audio: false, context: {} } });
  assert.equal(response.ok, true);
  assert.deepEqual(h.constraints, { video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'low-load', maxFrameRate: 20, maxWidth: 1280, maxHeight: 1280 } }, audio: false });
});

test('普通画质在首次采集就限制整页尺寸，原始尺寸不偷偷降低清晰度', async t => {
  const h = await harness(t);
  for (const [quality, maximum] of [['1080', 1920], ['720', 1280], ['original', undefined]]) {
    await h.send({ type: 'START', streamId: 'bounded', options: { quality, fps: 30, context: {} } });
    assert.equal(h.constraints.video.mandatory.maxWidth, maximum);
    assert.equal(h.constraints.video.mandatory.maxHeight, maximum);
    assert.equal(h.constraints.video.mandatory.maxFrameRate, 30);
  }
});

test('CSS 确认失败会停止已获得的来源，不开始录制', async t => {
  const h = await harness(t), pending = h.start(); await tick();
  h.gate.resolve({ ok: false, error: '原框选区域已超出画面，请重新框选' });
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /超出画面/);
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.started, undefined);
});

test('等待 CSS 确认时取消会立即停流，迟到成功响应不能继续录制', async t => {
  const h = await harness(t), pending = h.start(); await tick();
  await h.send({ type: 'STOP', sessionId: 'session' });
  assert.equal(h.track.readyState, 'ended');
  h.gate.resolve({ ok: true, crop: {}, cropViewport: {} });
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(h.started, undefined);
});

test('离屏启动失败把可复制的诊断信息传回后台', async t => {
  const h = await harness(t);
  // Fail from acquisition with structured detail, without requiring a real GPU.
  globalThis.navigator.mediaDevices.getUserMedia = async () => {
    const error = new Error('frame unavailable'); error.detail = 'frame=1920x1080; viewport=1395x896'; throw error;
  };
  const response = await h.start();
  assert.equal(response.ok, false); assert.equal(response.detail, 'frame=1920x1080; viewport=1395x896');
});
