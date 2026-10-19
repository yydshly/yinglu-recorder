import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoOutput, sourceConstraints } from '../lib/video.js';

function harness(t, { reject = false, ignoreSize = false, frameDriven = false } = {}) {
  const calls = { elements: [], draws: 0, requested: 0, constraints: [], timers: new Map(), qualityReads: 0 };
  const settings = { width: 2560, height: 1440, frameRate: 60 };
  const track = { getSettings: () => { calls.settingsReads = (calls.settingsReads || 0) + 1; return settings; }, async applyConstraints(c) {
    calls.constraints.push(c);
    if (reject && c.width) throw new Error('resize unavailable');
    settings.frameRate = c.frameRate.max;
    if (c.width && !ignoreSize) { settings.height *= c.width.max / settings.width; settings.width = c.width.max; }
  } };
  const outputTrack = { stop() {}, requestFrame() { calls.requested++; } };
  const videoHandlers = {};
  const video = { videoWidth: 2560, videoHeight: 1440, readyState: 4,
    addEventListener(type, fn) { videoHandlers[type] = fn; },
    removeEventListener(type, fn) { if (videoHandlers[type] === fn) delete videoHandlers[type]; },
    async play() { this.videoWidth = settings.width; this.videoHeight = settings.height; },
    pause() { calls.paused = true; }, getVideoPlaybackQuality: () => { calls.qualityReads++; return { totalVideoFrames: calls.frames || 1, droppedVideoFrames: calls.dropped || 0, corruptedVideoFrames: 0 }; } };
  if (frameDriven) {
    video.requestVideoFrameCallback = fn => { calls.frame = fn; return 12; };
    video.cancelVideoFrameCallback = id => { calls.cancelledFrame = id; };
  }
  let timerId = 0;
  t.mock.method(globalThis, 'setInterval', (fn, ms) => { calls.tick = fn; calls.timers.set(++timerId, { fn, ms }); return timerId; });
  t.mock.method(globalThis, 'clearInterval', id => calls.timers.delete(id));
  const previous = { document: globalThis.document, MediaStream: globalThis.MediaStream };
  globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } };
  globalThis.document = { createElement(tag) {
    calls.elements.push(tag);
    if (tag === 'video') return video;
    return calls.canvas = { getContext: () => ({ fillRect() { calls.letterbox = true; }, drawImage(...args) { calls.draws++; calls.drawArgs = args; } }),
      captureStream: () => ({ getVideoTracks: () => [outputTrack], getTracks: () => [outputTrack] }) };
  } };
  t.after(() => Object.assign(globalThis, previous));
  return { calls, track, settings, video, videoHandlers, source: { getVideoTracks: () => [track] } };
}

test('完整网页在源头限制尺寸和帧率，编码原轨道，不创建视频/画布或循环', async t => {
  const { calls, source, track } = harness(t);
  const result = await createVideoOutput(source, { quality: '720', fps: 30 });
  assert.equal(result.mode, 'direct');
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.equal(result.stream.getVideoTracks()[0], track);
  assert.deepEqual(calls.elements, []); assert.equal(calls.tick, undefined);
});

test('普通区域默认限制4K整页来源到1920，原始尺寸仍是明确的细节优先选择', async t => {
  const h = harness(t); h.settings.width = 3840; h.settings.height = 2160;
  const crop = { x: .4, y: .4, width: .1, height: .1 };
  const result = await createVideoOutput(h.source, { crop, fps: 30 });
  assert.equal(h.settings.width, 1920); assert.equal(h.settings.height, 1080);
  assert.equal(result.width, 192); assert.equal(result.height, 108);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [768, 432, 192, 108]); result.cleanup();
  assert.equal(sourceConstraints({ width: 3840, height: 2160 }, { crop, quality: 'original' }).width, undefined);
  assert.equal(sourceConstraints({}, { crop, quality: '720' }).width.max, 1280);
});

test('源拒绝调整尺寸时回退裁切管线，不偷偷输出超大视频', async t => {
  const { calls, source } = harness(t, { reject: true });
  const result = await createVideoOutput(source, { quality: '720', fps: 30 });
  assert.equal(result.mode, 'canvas'); assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.equal(calls.constraints.length, 2); result.cleanup();
});

test('来源已经符合尺寸时，拒绝尺寸约束也不引入多余画布管线', async t => {
  const { source, settings, calls } = harness(t, { reject: true });
  settings.width = 1280; settings.height = 720;
  const result = await createVideoOutput(source, { quality: '720', fps: 30 });
  assert.equal(result.mode, 'direct'); assert.equal(calls.constraints.length, 2);
  assert.deepEqual(calls.elements, []); assert.equal(calls.tick, undefined);
});

test('源忽略尺寸约束时仍执行输出缩放', async t => {
  const { source } = harness(t, { ignoreSize: true });
  const result = await createVideoOutput(source, { quality: '720' });
  assert.equal(result.mode, 'canvas'); assert.equal(result.width, 1280); result.cleanup();
});

test('框选保持源分辨率；重复帧及暂停期间不重绘，恢复立即更新', async t => {
  const { calls, source } = harness(t);
  const result = await createVideoOutput(source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 } });
  assert.equal(result.mode, 'canvas'); assert.equal(result.width, 1280); assert.equal(result.height, 1440);
  assert.equal(calls.constraints[0].width, undefined);
  assert.equal(calls.draws, 1); calls.tick(); assert.equal(calls.draws, 1);
  calls.frames = 2; calls.tick(); assert.equal(calls.draws, 2);
  result.setPaused(true); calls.frames = 3; calls.tick(); assert.equal(calls.draws, 2);
  result.setPaused(false); assert.equal(calls.draws, 3); assert.equal(calls.requested, 3);
  result.cleanup();
});

test('普通画质限制整帧来源，大小区域遵守同一采集预算', async t => {
  const settings = { width: 3840, height: 2160 };
  const large = sourceConstraints(settings, { crop: { width: .5, height: .5 }, quality: '720' });
  assert.equal(large.width.max, 1280); assert.equal(large.height.max, 720);
  assert.equal(sourceConstraints(settings, { crop: { width: .1, height: .1 }, quality: '720' }).width.max, 1280);
  const { source, calls } = harness(t);
  const result = await createVideoOutput(source, { crop: { x: 0, y: 0, width: .8, height: .8 }, quality: '720' });
  assert.equal(calls.constraints[0].width.max, 1280);
  assert.equal(result.width, 1024); assert.equal(result.height, 576); result.cleanup();
});

test('低负载模式限制整帧采集像素和20FPS，小选区不再保留4K来源', async t => {
  const crop = { x: .4, y: .4, width: .2, height: .2 };
  const settings = { width: 3840, height: 2160 };
  assert.equal(sourceConstraints(settings, { crop, quality: '720' }).width.max, 1280);
  assert.deepEqual(sourceConstraints(settings, { crop, quality: 'performance', fps: 20 }), {
    frameRate: { ideal: 20, max: 20 }, width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }
  });
  assert.deepEqual(sourceConstraints({}, { crop, quality: 'performance', fps: 20 }), {
    frameRate: { ideal: 20, max: 20 }, width: { max: 1280 }, height: { max: 1280 }
  });
  const h = harness(t);
  const result = await createVideoOutput(h.source, { crop, quality: 'performance', fps: 20 });
  assert.equal(h.settings.width, 1280); assert.equal(h.settings.height, 720); assert.equal(h.settings.frameRate, 20);
  assert.equal(result.width, 256); assert.equal(result.height, 144);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [512, 288, 256, 144]);
  assert.equal(result.getPerformance().requestedFrameRate, 20); result.cleanup();
});

test('低负载模式不放大较小来源，源拒绝缩放仍按20FPS与1280输出兜底', async t => {
  assert.deepEqual(sourceConstraints({ width: 640, height: 360 }, { quality: 'performance', fps: 20 }).width, { ideal: 640, max: 640 });
  const h = harness(t, { reject: true });
  const result = await createVideoOutput(h.source, { crop: { x: 0, y: 0, width: 1, height: 1 }, quality: 'performance', fps: 20 });
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  assert.deepEqual(h.calls.constraints[1], { frameRate: { ideal: 20, max: 20 } });
  result.cleanup();
});

test('20FPS裁切按50ms节拍绘制，不把低帧率静默恢复为30FPS', async t => {
  const h = harness(t, { frameDriven: true });
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 }, fps: 20 });
  const now = performance.now(); h.calls.frames = 2;
  h.calls.frame(now + 30); assert.equal(h.calls.draws, 1);
  h.calls.frame(now + 55); assert.equal(h.calls.draws, 2);
  h.calls.frames = 3; h.calls.frame(now + 80); assert.equal(h.calls.draws, 2);
  h.calls.frame(now + 105); assert.equal(h.calls.draws, 3);
  result.cleanup();
});

test('支持视频帧回调时只随新帧绘制，结束后取消回调', async t => {
  const { calls, source } = harness(t, { frameDriven: true });
  const result = await createVideoOutput(source, { crop: { x: 0, y: 0, width: .5, height: 1 } });
  const now = performance.now();
  assert.equal(calls.draws, 1); calls.frames = 2; calls.frame(now + 100); assert.equal(calls.draws, 2);
  calls.frame(now + 200); assert.equal(calls.draws, 2);
  result.cleanup(); assert.equal(calls.cancelledFrame, 12);
  calls.frames = 3; calls.frame(now + 300); assert.equal(calls.draws, 2);
});

test('区域来源尺寸变化通知一次并停止绘制，防止录入漂移区域', async t => {
  const { calls, source, video } = harness(t);
  const errors = [];
  const result = await createVideoOutput(source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 }, onSourceResize: e => errors.push(e) });
  video.videoWidth = 2000; calls.frames = 2; calls.tick(); calls.tick();
  assert.equal(errors.length, 1); assert.match(errors[0], /重新框选/); assert.equal(calls.draws, 1); result.cleanup();
});

test('启动约束已生效但解码尺寸迟到时，等比例重协商不终止区域录制', async t => {
  const h = harness(t), errors = [];
  h.video.play = async () => {}; // The first decoded frame still has the old resolution.
  const result = await createVideoOutput(h.source, { crop: { x: .2, y: .1, width: .8, height: .8 }, quality: '720', onSourceResize: e => errors.push(e) });
  assert.equal(h.settings.width, 1280); assert.equal(h.video.videoWidth, 2560);
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  h.video.videoWidth = 1280; h.video.videoHeight = 720;
  h.videoHandlers.resize(); h.calls.frames = 2; h.calls.tick();
  assert.deepEqual(errors, []); assert.equal(h.calls.draws, 2);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [256, 72, 1024, 576]);
  assert.equal(result.getPerformance().canvas.sourceResolutionChanges, 1);
  assert.equal(result.getPerformance().canvas.decodedSourceWidth, 1280);
  result.cleanup(); assert.equal(h.videoHandlers.resize, undefined);
});

test('轨道设置先变、解码帧尚未变化时不误报；新帧到达后重映射同一选区', async t => {
  const h = harness(t, { frameDriven: true }), errors = [];
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 }, onSourceResize: e => errors.push(e) });
  h.settings.width = 1280; h.settings.height = 720;
  h.calls.tick(); assert.deepEqual(errors, []);
  h.video.videoWidth = 1280; h.video.videoHeight = 720;
  h.videoHandlers.resize(); h.calls.frame(performance.now() + 100);
  assert.deepEqual(errors, []); assert.equal(h.calls.draws, 2);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [640, 0, 640, 720]);
  assert.equal(result.width, 1280); assert.equal(result.height, 1440);
  result.cleanup();
});

test('网页CSS视口已确认而解码帧仍旧时，等待对应新帧后才固定裁切像素', async t => {
  const h = harness(t), errors = [];
  const pending = createVideoOutput(h.source, { crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 }, onSourceResize: e => errors.push(e) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.elements, ['video']);
  h.video.videoWidth = 960; h.video.videoHeight = 640; h.videoHandlers.resize();
  const result = await pending;
  assert.equal(result.width, 480); assert.equal(result.height, 640);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [480, 0, 480, 640]);
  assert.deepEqual(errors, []); result.cleanup();
});

test('等待与网页视口匹配的解码帧期间可取消并释放所有资源', async t => {
  const h = harness(t), controller = new AbortController();
  const pending = createVideoOutput(h.source, { crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 }, signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejection;
  assert.equal(h.calls.paused, true); assert.equal(h.video.srcObject, null); assert.equal(h.videoHandlers.resize, undefined);
  assert.deepEqual(h.calls.elements, ['video']);
});

test('网页允许的2 CSS像素误差在高DPI及缩放后仍可启动区域录制', async t => {
  const h = harness(t);
  for (const scale of [.75, 1, 1.25, 1.5, 2, 3]) {
    h.settings.width = Math.round(1280 * scale); h.settings.height = Math.round(720 * scale);
    const result = await createVideoOutput(h.source, { quality: 'original',
      crop: { x: .25, y: .1, width: .5, height: .5, viewportWidth: 1280, viewportHeight: 722 } });
    assert.equal(result.mode, 'canvas', `capture scale ${scale}`);
    assert.deepEqual(h.calls.drawArgs.slice(1, 5), [Math.round(h.settings.width * .25), Math.round(h.settings.height * .1),
      Math.round(h.settings.width * .5), Math.round(h.settings.height * .5)]);
    result.cleanup();
  }
});

test('高DPI录制中等比例重协商仍按CSS容差校验，真实宽高比改变仍停止', async t => {
  const h = harness(t), errors = [];
  const result = await createVideoOutput(h.source, { quality: 'original',
    crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1280, viewportHeight: 722 }, onSourceResize: error => errors.push(error) });
  h.video.videoWidth = 3840; h.video.videoHeight = 2160; h.videoHandlers.resize();
  h.calls.frames = 2; h.calls.tick();
  assert.deepEqual(errors, []); assert.deepEqual(h.calls.drawArgs.slice(1, 5), [1920, 0, 1920, 2160]);
  assert.equal(result.width, 1280); assert.equal(result.height, 1440);
  h.video.videoHeight = 1800; h.videoHandlers.resize(); h.calls.tick();
  assert.equal(errors.length, 1); assert.match(errors[0], /宽高比/); assert.equal(h.calls.draws, 2);
  result.cleanup();
});

test('CSS像素容差不会放过真正不匹配的初始采集画面', async t => {
  const h = harness(t);
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => schedule(fn, delay === 2000 ? 0 : delay, ...args));
  h.settings.width = 2560; h.settings.height = 1200;
  await assert.rejects(createVideoOutput(h.source, { quality: 'original',
    crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1280, viewportHeight: 720 } }), error => {
      assert.match(error.message, /视口与采集画面不匹配/);
      assert.deepEqual(JSON.parse(error.detail), { code: 'CAPTURE_VIEWPORT_MISMATCH',
        viewport: { width: 1280, height: 720 }, frame: { width: 2560, height: 1200 }, layout: 'full-frame' });
      return true;
    });
  assert.equal(h.calls.paused, true); assert.equal(h.videoHandlers.resize, undefined);
});

test('Chrome固定帧左右补边不误报不稳定，选区映射到网页内容而非整帧', async t => {
  const h = harness(t);
  const result = await createVideoOutput(h.source, { quality: 'original', captureLayout: 'chrome-tab',
    crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 } });
  assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [1280, 0, 1080, 1440]);
  assert.deepEqual(result.getPerformance().canvas.contentRect, { x: 200, y: 0, width: 2160, height: 1440 });
  assert.equal(result.getPerformance().canvas.captureLayout, 'chrome-tab');
  result.cleanup(); assert.equal(h.calls.paused, true);
});

test('Chrome固定帧上下补边时选区包含正确的纵向偏移，不录黑边', async t => {
  const h = harness(t); h.settings.width = 1280; h.settings.height = 720;
  const result = await createVideoOutput(h.source, { quality: 'original', captureLayout: 'chrome-tab',
    crop: { x: 0, y: .5, width: 1, height: .5, viewportWidth: 1600, viewportHeight: 800 } });
  assert.deepEqual(result.getPerformance().canvas.contentRect, { x: 0, y: 40, width: 1280, height: 640 });
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [0, 360, 1280, 320]);
  assert.equal(result.width, 1280); assert.equal(result.height, 320); result.cleanup();
});

test('Chrome容器比例重协商重新映射内容及选区，输出尺寸固定且不当作CSS变化', async t => {
  const h = harness(t), errors = [];
  const result = await createVideoOutput(h.source, { quality: 'original', captureLayout: 'chrome-tab',
    crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 }, onSourceResize: error => errors.push(error) });
  h.video.videoWidth = 1440; h.video.videoHeight = 1440; h.calls.frames = 2; h.videoHandlers.resize(); h.calls.tick();
  assert.deepEqual(errors, []); assert.deepEqual(h.calls.drawArgs.slice(1, 5), [720, 240, 720, 960]);
  assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  assert.equal(result.getPerformance().canvas.sourceResolutionChanges, 1); result.cleanup();
});

test('异步准备时修改传入选区不会替换本次录制范围', async t => {
  const h = harness(t);
  const crop = { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 };
  const options = { quality: 'original', captureLayout: 'chrome-tab', crop };
  const pending = createVideoOutput(h.source, options);
  crop.x = 0; crop.width = 1; crop.viewportHeight = 400;
  options.crop = null; options.captureLayout = 'full-frame';
  const result = await pending;
  assert.equal(result.mode, 'canvas');
  assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [1280, 0, 1080, 1440]);
  assert.equal(result.getPerformance().canvas.captureLayout, 'chrome-tab');
  result.cleanup();
});

test('录制后修改原选区、暂停及容器重协商仍沿用首次固定范围', async t => {
  const h = harness(t), errors = [];
  const crop = { x: .5, y: 0, width: .5, height: 1, viewportWidth: 1200, viewportHeight: 800 };
  const options = { quality: 'original', captureLayout: 'chrome-tab', crop, onSourceResize: error => errors.push(error) };
  const result = await createVideoOutput(h.source, options);
  result.setPaused(true);
  Object.assign(crop, { x: 0, width: 1, viewportWidth: 800, viewportHeight: 1200 });
  options.crop = null;
  h.video.videoWidth = 1440; h.video.videoHeight = 1440;
  h.videoHandlers.resize(); h.calls.frames = 2; h.calls.tick();
  assert.equal(h.calls.draws, 1);
  result.setPaused(false);
  assert.deepEqual(errors, []); assert.equal(h.calls.draws, 2);
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [720, 240, 720, 960]);
  assert.equal(result.width, 1080); assert.equal(result.height, 1440);
  assert.equal(result.getPerformance().canvas.sourceResolutionChanges, 1);
  result.cleanup();
});

test('Chrome偶数采集帧的内容原点与尺寸按色度采样对齐，接近全页选区不会越界', async t => {
  const h = harness(t); h.settings.width = 1920; h.settings.height = 1080;
  const result = await createVideoOutput(h.source, { quality: 'original', captureLayout: 'chrome-tab',
    crop: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1395, viewportHeight: 896 } });
  assert.deepEqual(h.calls.drawArgs.slice(1, 5), [118, 0, 1682, 1080]);
  assert.equal(result.width, 1682); assert.equal(result.height, 1080); result.cleanup();
});

test('暂停期间等比例分辨率变化不重绘，继续后沿用固定输出尺寸与正确选区', async t => {
  const h = harness(t), errors = [];
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: .25, width: .5, height: .5 }, onSourceResize: e => errors.push(e) });
  result.setPaused(true); h.video.videoWidth = 1280; h.video.videoHeight = 720; h.videoHandlers.resize(); h.calls.tick();
  assert.equal(h.calls.draws, 1); assert.deepEqual(errors, []);
  result.setPaused(false);
  assert.equal(h.calls.draws, 2); assert.deepEqual(h.calls.drawArgs.slice(1, 5), [640, 180, 640, 360]);
  assert.equal(result.width, 1280); assert.equal(result.height, 720);
  h.video.videoWidth = 1000; h.calls.tick(); h.calls.tick();
  assert.equal(errors.length, 1); assert.match(errors[0], /宽高比/); assert.equal(h.calls.draws, 2);
  result.cleanup();
});

test('全画面回退在来源宽高比变化时留黑边，避免把画面拉伸', async t => {
  const { calls, source, video } = harness(t, { reject: true });
  const result = await createVideoOutput(source, { quality: '720' });
  video.videoWidth = 1000; video.videoHeight = 1000; calls.frames = 2; calls.tick();
  assert.equal(calls.letterbox, true); assert.deepEqual(calls.drawArgs.slice(-4), [280, 0, 720, 720]); result.cleanup();
});

test('等待视频首帧期间取消会立即释放视频元素，不等待play完成', async t => {
  const { source, video, calls } = harness(t);
  video.play = () => new Promise(() => {});
  const controller = new AbortController();
  const pending = createVideoOutput(source, { crop: { x: 0, y: 0, width: .5, height: 1 }, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected;
  assert.equal(calls.paused, true); assert.equal(video.srcObject, null);
});

test('直接管线诊断只报告设置，不为测帧率创建视频或循环', async t => {
  const { calls, source } = harness(t);
  const result = await createVideoOutput(source, { quality: '720', fps: 30 });
  const diagnostic = result.getPerformance();
  assert.equal(diagnostic.sourceSettingsBeforeConstraints.width, 2560);
  assert.equal(diagnostic.sourceSettingsBeforeConstraints.frameRateSetting, 60);
  assert.equal(diagnostic.outputSettings.width, 1280); assert.equal(diagnostic.outputSettings.frameRateSetting, 30);
  assert.equal(diagnostic.settingsAreNotMeasuredFps, true); assert.equal(diagnostic.canvas, undefined);
  assert.deepEqual(calls.elements, []); assert.equal(calls.tick, undefined);
});

test('画布诊断累计绘制提交耗时和掉帧，快照独立且不逐帧查询轨道设置', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock++);
  const { calls, source } = harness(t);
  const result = await createVideoOutput(source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 } });
  const settingsReads = calls.settingsReads;
  calls.frames = 2; calls.dropped = 1; calls.tick(); calls.tick();
  const snapshot = result.getPerformance();
  assert.equal(snapshot.canvas.drawnFrames, 2); assert.equal(snapshot.canvas.drawSubmitMsTotal, 2);
  assert.equal(snapshot.canvas.drawSubmitMsMax, 1); assert.equal(snapshot.canvas.playbackDroppedVideoFrames, 1);
  assert.equal(snapshot.canvas.fallbackActivations, 1); assert.equal(snapshot.canvas.fallbackDrawnFrames, 1);
  assert.equal(snapshot.canvas.duplicateFramesSkipped, 1);
  calls.frames = 3; calls.tick();
  assert.equal(snapshot.canvas.drawnFrames, 2); assert.equal(result.getPerformance().canvas.drawnFrames, 3);
  assert.equal(calls.settingsReads, settingsReads); result.cleanup();
});

test('区域暂停停止全部裁切定时器和视频解码，继续后仅恢复一个调度链', async t => {
  for (const frameDriven of [false, true]) {
    const h = harness(t, { frameDriven });
    const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 } });
    const stale = h.calls.frame;
    result.setPaused(true);
    assert.equal(h.calls.timers.size, 0); assert.equal(h.calls.paused, true);
    if (frameDriven) assert.equal(h.calls.cancelledFrame, 12);
    result.setPaused(false); assert.equal(h.calls.timers.size, 1);
    const draws = h.calls.draws; h.calls.frames = 7;
    stale?.(performance.now() + 300, { presentedFrames: 7 });
    assert.equal(h.calls.draws, draws, '暂停前迟到回调不能另起绘制链');
    result.cleanup(); assert.equal(h.calls.timers.size, 0);
  }
});

test('帧回调使用原生 presentedFrames，连续新帧不逐帧读取播放统计', async t => {
  const h = harness(t, { frameDriven: true });
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 } });
  const initialReads = h.calls.qualityReads, now = performance.now();
  for (let i = 1; i <= 10; i++) h.calls.frame(now + i * 40, { presentedFrames: i + 1 });
  assert.equal(h.calls.draws, 11); assert.equal(h.calls.qualityReads, initialReads);
  assert.equal(result.getPerformance().canvas.drawnFrames, 11);
  assert.equal(h.calls.qualityReads, initialReads + 1, '只在诊断快照时补读统计');
  result.cleanup();
});

test('清理裁切输出立即释放像素缓冲，诊断仍保留原来的输出尺寸', async t => {
  const h = harness(t);
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 } });
  const { width, height } = result; result.cleanup();
  assert.equal(h.calls.canvas.width, 0); assert.equal(h.calls.canvas.height, 0);
  assert.equal(result.getPerformance().outputSettings.width, width);
  assert.equal(result.getPerformance().outputSettings.height, height);
});

test('继续时视频播放失败会结束裁切调度并通知保存，过期的播放错误不影响新一次继续', async t => {
  const h = harness(t, { frameDriven: true }), errors = [];
  const result = await createVideoOutput(h.source, { quality: 'original', crop: { x: .5, y: 0, width: .5, height: 1 }, onSourceResize: e => errors.push(e) });
  result.setPaused(true);
  let rejectOld;
  h.video.play = () => new Promise((_, reject) => { rejectOld = reject; });
  result.setPaused(false); result.setPaused(true);
  h.video.play = () => Promise.resolve(); result.setPaused(false);
  rejectOld(new Error('旧的播放被暂停')); await Promise.resolve();
  assert.deepEqual(errors, []); assert.equal(h.calls.timers.size, 1);
  result.setPaused(true); h.video.play = () => Promise.reject(new Error('设备故障'));
  result.setPaused(false); await Promise.resolve();
  assert.equal(errors.length, 1); assert.match(errors[0], /恢复播放失败.*设备故障/);
  assert.equal(h.calls.timers.size, 0); result.cleanup();
});
