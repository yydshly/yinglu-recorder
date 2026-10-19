import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chooseRecordingMime } from '../lib/media-format.js';
const original = await readFile(new URL('../lib/recorder.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function loadRecorder() {
  const code = original.replace(/^import .*;\r?\n/gm, '').replace('export class Recorder',
    'const {elapsed,saveRecording,saveChunk,deleteRecording,patchRecording,createVideoOutput,chooseRecordingMime,createRecordingMusic} = globalThis.recorderTest; export class Recorder');
  return (await import(`data:text/javascript;base64,${Buffer.from(code + '\n//' + Math.random()).toString('base64')}`)).Recorder;
}

async function harness(t, { start = true } = {}) {
  let resolveWrite, rejectWrite;
  const gate = new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; }, addEventListener() {} };
  const stream = { getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] };
  const old = { MediaRecorder: globalThis.MediaRecorder, recorderTest: globalThis.recorderTest };
  const published = [], savedRecords = [], patches = [], persisted = new Map();
  globalThis.recorderTest = {
    chooseRecordingMime,
    elapsed: () => 1000,
    saveRecording: async record => { savedRecords.push(structuredClone(record)); persisted.set(record.id, structuredClone(record)); },
    saveChunk: async (id, index, blob, record) => { await gate; persisted.set(id, structuredClone(record)); },
    patchRecording: async (id, patch) => {
      patches.push({ id, patch: structuredClone(patch) });
      if (!persisted.has(id)) return;
      const updated = { ...persisted.get(id), ...structuredClone(patch) }; persisted.set(id, updated); return structuredClone(updated);
    },
    deleteRecording: async id => { persisted.delete(id); },
    createVideoOutput: async (source, options) => {
      globalThis.recorderTest.videoOptions = options;
      return { stream, width: 1280, height: 720, mode: 'direct', setPaused() {}, cleanup() {} };
    }
  };
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    resume() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop()); }
  };
  t.after(() => Object.assign(globalThis, old));
  const Recorder = await loadRecorder();
  const recorder = new Recorder(state => published.push({ ...state, track: track.readyState }));
  if (start) {
    await recorder.start(stream);
    recorder.mediaRecorder.ondataavailable({ data: new Blob(['frame']) });
    await tick();
  }
  return { recorder, track, stream, published, savedRecords, patches, persisted, resolveWrite, rejectWrite, Recorder };
}

test('磁盘仍在写入时先释放来源，完成通知只在释放之后出现', async t => {
  const h = await harness(t); h.recorder.stop(); await tick();
  assert.equal(h.recorder.state.status, 'saving');
  assert.equal(h.track.readyState, 'ended');
  assert.equal(h.recorder.state.released, true);
  h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'complete');
  assert.equal(h.published.find(s => s.status === 'complete').track, 'ended');
});

test('来源建立后采用最终确认的区域上下文，后续状态不回写采集前尺寸', async t => {
  const h = await harness(t, { start: false });
  const options = { crop: { x: .5, y: .5, width: .25, height: .25 },
    context: { sessionId: 'region', cropViewport: { viewportWidth: 1200, viewportHeight: 800 } } };
  await h.recorder.start(async () => {
    options.crop = { x: .5, y: 400 / 760, width: .25, height: 200 / 760 };
    options.context.cropViewport = { viewportWidth: 1200, viewportHeight: 760 };
    return h.stream;
  }, options);
  assert.deepEqual(globalThis.recorderTest.videoOptions.crop, options.crop);
  const recording = h.published.find(state => state.status === 'recording');
  assert.deepEqual(recording.cropViewport, { viewportWidth: 1200, viewportHeight: 760 });
  h.recorder.stop(); await tick();
  assert.deepEqual(h.recorder.state.cropViewport, recording.cropViewport);
});

test('20FPS低负载设置贯通裁切、编码码率与保存元数据', async t => {
  const h = await harness(t, { start: false });
  await h.recorder.start(h.stream, { fps: 20, quality: 'performance' });
  assert.equal(recorderTest.videoOptions.fps, 20); assert.equal(recorderTest.videoOptions.quality, 'performance');
  assert.equal(h.savedRecords[0].fps, 20);
  assert.equal(h.recorder.encoderPerformance.requestedVideoBitsPerSecond, Math.round(1280 * 720 * 20 * .13));
  h.recorder.stop(); await tick();
});

test('视频准备失败保留尺寸诊断到错误状态并释放来源', async t => {
  const h = await harness(t, { start: false });
  globalThis.recorderTest.createVideoOutput = async () => {
    const error = new Error('视口与采集画面不匹配'); error.detail = 'viewport=1395x896; frame=1920x1080'; throw error;
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await assert.rejects(recorder.start(h.stream), /不匹配/);
  assert.equal(recorder.state.status, 'error'); assert.equal(recorder.state.released, true);
  assert.equal(recorder.state.detail, 'viewport=1395x896; frame=1920x1080');
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.savedRecords.length, 0);
});

test('唯一片段写入失败时显示失败及真实错误，不声称已保存片段', async t => {
  const h = await harness(t); h.recorder.stop(); await tick();
  h.rejectWrite(new Error('disk full')); await tick();
  assert.equal(h.recorder.state.status, 'error');
  assert.match(h.recorder.state.error, /disk full/);
  assert.equal(h.recorder.record.status, 'error');
  assert.equal(h.track.readyState, 'ended');
  assert.equal(h.published.some(s => s.status === 'complete'), false);
});

test('积压超过上限自动停止采集，避免无限排队', async t => {
  const h = await harness(t);
  h.recorder.mediaRecorder.ondataavailable({ data: { size: 65 * 1024 * 1024 } });
  await tick(); assert.equal(h.track.readyState, 'ended');
  assert.match(h.recorder.state.error, /写入跟不上/);
  h.resolveWrite(); await tick(); assert.equal(h.recorder.state.status, 'interrupted');
});

test('来源授权尚未返回也能取消；迟到的来源立即释放且不启动编码', async t => {
  const h = await harness(t, { start: false });
  let resolveSource;
  const pending = h.recorder.start(() => new Promise(resolve => { resolveSource = resolve; }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.recorder.state.status, 'preparing');
  h.recorder.stop(); await rejected;
  assert.equal(h.recorder.state.status, 'cancelled'); assert.equal(h.recorder.state.released, true);
  resolveSource(h.stream); await tick();
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.recorder.mediaRecorder, null);
  assert.equal(h.published.some(s => s.status === 'recording'), false);
});

test('准备超时会释放来源，迟到的输出管线也会清理', async t => {
  const h = await harness(t, { start: false });
  // Reload the class with a pending video initializer captured in its imports.
  let resolveOutput, disposed = false;
  recorderTest.createVideoOutput = () => new Promise(resolve => { resolveOutput = resolve; });
  const Recorder = await loadRecorder();
  const recorder = new Recorder();
  await assert.rejects(recorder.start(h.stream, { prepareTimeoutMs: 20 }), /超时/);
  assert.equal(h.track.readyState, 'ended'); assert.equal(recorder.state.status, 'error');
  resolveOutput({ cleanup() { disposed = true; } }); await tick(); assert.equal(disposed, true);
});

test('麦克风授权等待可取消，返回的麦克风轨道不会泄漏', async t => {
  const h = await harness(t, { start: false });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolveMic, micStopped = false;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise(resolve => { resolveMic = resolve; })
  } } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'navigator', previous) : delete globalThis.navigator);
  const pending = h.recorder.start(h.stream, { microphone: true });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); h.recorder.stop(); await rejected;
  assert.equal(h.track.readyState, 'ended');
  resolveMic({ getTracks: () => [{ stop() { micStopped = true; } }] }); await tick();
  assert.equal(micStopped, true); assert.equal(h.recorder.state.status, 'cancelled');
});

test('区域来源尺寸变化会停止并保留已有片段，明确要求重新框选', async t => {
  const h = await harness(t);
  recorderTest.videoOptions.onSourceResize('录制来源尺寸发生变化，请重新框选。');
  await tick(); assert.equal(h.track.readyState, 'ended');
  h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'interrupted'); assert.match(h.recorder.state.error, /重新框选/);
});

test('关闭来源声音后不混入来源音轨，也不创建监听音频节点', async t => {
  const h = await harness(t, { start: false });
  h.stream.getAudioTracks = () => [{ kind: 'audio' }];
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { throw new Error('来源静音时不应创建音频节点'); } };
  t.after(() => { globalThis.AudioContext = previous; });
  await h.recorder.start(h.stream, { audio: false });
  assert.equal(h.recorder.state.status, 'recording'); h.recorder.stop(); await tick();
});

test('恢复绘制时发现来源变化不会重新覆盖停止保存状态', async t => {
  const h = await harness(t);
  h.recorder.state.status = 'paused'; h.recorder.state.pausedAt = Date.now();
  h.recorder.videoOutput.setPaused = value => { if (!value) h.recorder.stop('来源变化，请重新框选'); };
  h.recorder.resume();
  assert.equal(h.recorder.state.status, 'saving');
  h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'interrupted');
});

test('取消未完成的初始元数据写入后会移除空记录', async t => {
  const h = await harness(t, { start: false });
  let resolveSave, deleted;
  recorderTest.saveRecording = () => new Promise(resolve => { resolveSave = resolve; });
  recorderTest.deleteRecording = async id => { deleted = id; };
  const Recorder = await loadRecorder();
  const recorder = new Recorder();
  const pending = recorder.start(h.stream); const rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); const id = recorder.record.id; recorder.stop(); await rejected;
  resolveSave(); await tick(); assert.equal(deleted, id);
});

test('编码器启动抛错后将空占位持久化为失败并释放采集', async t => {
  const h = await harness(t, { start: false });
  MediaRecorder.prototype.start = () => { throw new DOMException('encoder cannot start', 'NotSupportedError'); };
  await assert.rejects(h.recorder.start(h.stream), /encoder cannot start/);
  const record = h.persisted.get(h.recorder.state.id);
  assert.equal(record.status, 'error'); assert.equal(record.bytes, 0);
  assert.match(record.interruption, /encoder cannot start/);
  assert.equal(h.recorder.state.status, 'error'); assert.equal(h.recorder.state.recoveryPending, false);
  assert.equal(h.recorder.state.released, true); assert.equal(h.track.readyState, 'ended');
  assert.equal(h.recorder.mediaRecorder, null); assert.equal(h.recorder.preparation, null);
  assert.equal(h.published.some(state => state.status === 'complete'), false);
});

test('启动抛错前已接收的有效片段仍保存，不删除或覆盖已确认大小', async t => {
  const h = await harness(t, { start: false }); h.resolveWrite();
  MediaRecorder.prototype.start = function () {
    this.ondataavailable({ data: new Blob(['first']) });
    this.ondataavailable({ data: new Blob(['next']) });
    throw new Error('encoder failed after delivering data');
  };
  await assert.rejects(h.recorder.start(h.stream), /encoder failed/);
  const record = h.persisted.get(h.recorder.state.id);
  assert.equal(record.status, 'interrupted'); assert.equal(record.bytes, 9); assert.equal(record.duration, 1000);
  assert.equal(h.recorder.state.status, 'interrupted'); assert.equal(h.recorder.state.bytes, 9);
  assert.equal(h.recorder.state.released, true); assert.equal(h.track.readyState, 'ended');
  assert.equal(h.published.some(state => state.status === 'complete'), false);
});

test('启动失败补丁超时有界返回，迟到补丁不污染下一次录制', async t => {
  const h = await harness(t, { start: false });
  let releasePatch, firstPatch = true;
  const patch = recorderTest.patchRecording;
  recorderTest.patchRecording = async (...args) => {
    if (firstPatch) { firstPatch = false; await new Promise(resolve => { releasePatch = resolve; }); }
    return patch(...args);
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  const start = MediaRecorder.prototype.start; let firstStart = true;
  MediaRecorder.prototype.start = function () {
    if (firstStart) { firstStart = false; throw new Error('first start failed'); }
    start.call(this);
  };
  const failed = recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  const rejected = assert.rejects(failed, /first start failed/);
  await tick(); assert.equal(h.track.readyState, 'ended');
  await rejected;
  const oldId = recorder.state.id;
  assert.equal(recorder.state.status, 'error'); assert.equal(recorder.state.recoveryPending, true);
  h.track.readyState = 'live'; await recorder.start(h.stream);
  const newId = recorder.state.id;
  releasePatch(); await tick();
  assert.equal(h.persisted.get(oldId).status, 'error'); assert.equal(h.persisted.get(oldId).bytes, 0);
  assert.equal(h.persisted.get(newId).status, 'recording');
  assert.equal(recorder.state.id, newId); assert.equal(recorder.state.status, 'recording');
  assert.equal(h.track.readyState, 'live'); recorder.stop(); await tick();
});

test('取消后迟到的初始保存只删除原空记录，不影响重试会话', async t => {
  const h = await harness(t, { start: false });
  const save = recorderTest.saveRecording;
  let releaseSave, firstSave = true;
  recorderTest.saveRecording = async record => {
    if (firstSave) { firstSave = false; await new Promise(resolve => { releaseSave = resolve; }); }
    return save(record);
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  const pending = recorder.start(h.stream), rejected = assert.rejects(pending, { name: 'AbortError' });
  await tick(); const oldId = recorder.state.id; recorder.stop(); await rejected;
  h.track.readyState = 'live'; await recorder.start(h.stream);
  const newId = recorder.state.id;
  releaseSave(); await tick();
  assert.equal(h.persisted.has(oldId), false); assert.equal(h.persisted.get(newId).status, 'recording');
  assert.equal(recorder.state.id, newId); assert.equal(recorder.state.status, 'recording');
  assert.equal(h.track.readyState, 'live'); recorder.stop(); await tick();
});

test('初始元数据写入前已发布准备中的录制ID，活动记录可被保护', async t => {
  const h = await harness(t, { start: false });
  let stateAtWrite, recorder;
  recorderTest.saveRecording = async record => { stateAtWrite = { ...recorder.state, storedId: record.id }; };
  const Recorder = await loadRecorder();
  recorder = new Recorder();
  await recorder.start(h.stream);
  assert.equal(stateAtWrite.status, 'preparing'); assert.equal(stateAtWrite.id, stateAtWrite.storedId);
  assert.ok(stateAtWrite.id);
  recorder.stop(); await tick();
});

test('离屏来源获取中可按会话取消，旧会话STOP不会取消新会话', async t => {
  const h = await harness(t, { start: false });
  const previousChrome = globalThis.chrome, previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let listener, resolveSource;
  globalThis.chrome = { runtime: { sendMessage: async () => {}, onMessage: { addListener(fn) { listener = fn; } } } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise(resolve => { resolveSource = resolve; })
  } } });
  t.after(() => {
    globalThis.chrome = previousChrome;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
  });
  recorderTest.Recorder = h.Recorder;
  const source = (await readFile(new URL('../offscreen.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/, 'const Recorder = globalThis.recorderTest.Recorder;\n');
  await import(`data:text/javascript;base64,${Buffer.from(source + '\n//' + Math.random()).toString('base64')}`);
  const send = message => new Promise(resolve => listener({ target: 'offscreen', ...message }, {}, resolve));
  const start = send({ type: 'START', streamId: 'source', options: { audio: false, context: { sessionId: 'new' } } });
  const ignored = await send({ type: 'STOP', sessionId: 'old' });
  assert.equal(ignored.ignored, true); assert.equal(ignored.state.status, 'preparing');
  const stopped = await send({ type: 'STOP', sessionId: 'new' });
  assert.equal(stopped.state.status, 'cancelled');
  assert.equal((await start).cancelled, true);
  resolveSource(h.stream); await tick(); assert.equal(h.track.readyState, 'ended');
});

test('编码器没有发出onstop也会超时释放来源并将已收到片段标为中断', async t => {
  const h = await harness(t); h.recorder.run.stopTimeoutMs = 15;
  h.recorder.mediaRecorder.stop = function () { this.state = 'inactive'; };
  h.recorder.stop(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.recorder.state.released, true);
  h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'interrupted'); assert.match(h.recorder.state.error, /编码器未响应/);
  assert.equal(h.published.some(state => state.status === 'complete'), false);
});

test('编码器stop抛错仍释放来源并保存现有片段', async t => {
  const h = await harness(t);
  h.recorder.mediaRecorder.stop = () => { throw new Error('encoder stalled'); };
  assert.doesNotThrow(() => h.recorder.stop());
  assert.equal(h.track.readyState, 'ended'); h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'interrupted'); assert.match(h.recorder.state.error, /encoder stalled/);
});

test('再次停止可立即强制清理，不必等待失去响应的onstop', async t => {
  const h = await harness(t);
  h.recorder.mediaRecorder.stop = function () { this.state = 'inactive'; };
  h.recorder.stop(); assert.equal(h.track.readyState, 'live');
  h.recorder.stop(); assert.equal(h.track.readyState, 'ended');
  h.resolveWrite(); await tick(); assert.equal(h.recorder.state.status, 'interrupted');
});

test('强制停止后的迟到onstop不会重复保存或终止下一次录制', async t => {
  const h = await harness(t);
  const oldEncoder = h.recorder.mediaRecorder;
  oldEncoder.stop = function () { this.state = 'inactive'; };
  h.recorder.stop(); h.recorder.stop(); h.resolveWrite(); await tick();
  const terminalCount = h.published.filter(state => state.status === 'interrupted').length;
  oldEncoder.onstop(); await tick();
  assert.equal(h.published.filter(state => state.status === 'interrupted').length, terminalCount);
  h.track.readyState = 'live'; await h.recorder.start(h.stream);
  const newId = h.recorder.state.id; oldEncoder.onstop();
  oldEncoder.ondataavailable({ data: new Blob(['late old frame']) }); await tick();
  assert.equal(h.recorder.state.id, newId); assert.equal(h.recorder.state.status, 'recording');
  assert.equal(h.recorder.index, 0);
  h.recorder.stop(); await tick();
});

test('片段写入一直不返回也不会永久停留在saving，迟到结果不再改终态', async t => {
  const h = await harness(t); h.recorder.run.finalizeTimeoutMs = 15;
  h.recorder.stop(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.track.readyState, 'ended'); assert.equal(h.recorder.state.status, 'error');
  assert.match(h.recorder.state.error, /保存等待超时/);
  h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.status, 'error'); assert.equal(h.published.some(state => state.status === 'complete'), false);
});

test('单一路网页声音直接编码原音轨，回放监听不创建混音输出', async t => {
  const h = await harness(t, { start: false });
  const added = [], connections = []; let audioStopped = false, contextClosed = false;
  const audioTrack = { kind: 'audio', stop() { audioStopped = true; } };
  h.stream.getAudioTracks = () => [audioTrack]; h.stream.getTracks = () => [h.track, audioTrack];
  h.stream.addTrack = track => added.push(track);
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor() { this.destination = { monitor: true }; }
    createMediaStreamDestination() { throw new Error('单一来源不需要混音输出'); }
    createMediaStreamSource() { return { connect(destination) { connections.push(destination); } }; }
    async resume() {} async close() { contextClosed = true; }
  };
  t.after(() => { globalThis.AudioContext = previous; });
  await h.recorder.start(h.stream, { audio: true, monitor: true });
  assert.deepEqual(added, [audioTrack]); assert.deepEqual(connections, [{ monitor: true }]);
  assert.deepEqual(h.recorder.record.performance.audio, { mode: 'direct', monitored: true, sourceTracks: 1, microphoneTracks: 0 });
  h.recorder.stop(); await tick(); assert.equal(audioStopped, true); assert.equal(contextClosed, true);
});

test('仅麦克风直接编码，无需AudioContext混音或监听', async t => {
  const h = await harness(t, { start: false });
  const added = [], micTrack = { stop() {} };
  const mic = { getAudioTracks: () => [micTrack], getTracks: () => [micTrack] };
  h.stream.addTrack = track => added.push(track);
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), previousAudio = globalThis.AudioContext;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => mic } } });
  globalThis.AudioContext = class { constructor() { throw new Error('单一麦克风不应建立混音'); } };
  t.after(() => {
    globalThis.AudioContext = previousAudio;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
  });
  await h.recorder.start(h.stream, { audio: false, microphone: true });
  assert.deepEqual(added, [micTrack]); assert.equal(h.recorder.record.performance.audio.mode, 'direct');
  h.recorder.stop(); await tick();
});

test('网页声音加麦克风仍合并为一个音轨并保留回放监听', async t => {
  const h = await harness(t, { start: false });
  const added = [], connections = [];
  const sourceAudio = { stop() {} }, micTrack = { stop() {} }, mixedTrack = { stop() {} };
  h.stream.getAudioTracks = () => [sourceAudio]; h.stream.addTrack = track => added.push(track);
  const mic = { getAudioTracks: () => [micTrack], getTracks: () => [micTrack] };
  const mixed = { stream: { getAudioTracks: () => [mixedTrack], getTracks: () => [mixedTrack] } };
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), previousAudio = globalThis.AudioContext;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => mic } } });
  globalThis.AudioContext = class {
    constructor() { this.destination = { monitor: true }; }
    createMediaStreamDestination() { return mixed; }
    createMediaStreamSource(stream) { return { connect(destination) { connections.push({ stream, destination }); } }; }
    async resume() {} async close() {}
  };
  t.after(() => {
    globalThis.AudioContext = previousAudio;
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
  });
  await h.recorder.start(h.stream, { audio: true, microphone: true, monitor: true });
  assert.deepEqual(added, [mixedTrack]); assert.equal(connections.filter(c => c.destination === mixed).length, 2);
  assert.equal(connections.filter(c => c.destination.monitor).length, 1);
  assert.equal(h.recorder.record.performance.audio.mode, 'mixed'); h.recorder.stop(); await tick();
});

async function musicHarness(t, factory) {
  const h = await harness(t, { start: false }), added = [], calls = [], mixedTrack = { stopped: false, stop() { this.stopped = true; } };
  h.stream.addTrack = track => added.push(track);
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor() { calls.push('context'); this.destination = { monitor: true }; }
    createMediaStreamDestination() { return { stream: { getAudioTracks: () => [mixedTrack], getTracks: () => [mixedTrack] } }; }
    async resume() { calls.push('resume-context'); } async close() { calls.push('close-context'); }
  };
  t.after(() => { globalThis.AudioContext = previous; });
  recorderTest.createRecordingMusic = factory || (async options => {
    const state = { id: 'song', name: '本机音乐', volume: .2, loop: true, playing: false };
    return { snapshot: () => ({ ...state }), start: async () => { calls.push('play'); state.playing = true; options.onChange({ ...state }); },
      close: () => { calls.push('close-music'); }, setRecordingPaused: value => { calls.push(['pause-music', value]); },
      control: async (command, value) => { calls.push([command, value]); if (command === 'volume') state.volume = value; options.onChange({ ...state }); } };
  });
  const Recorder = await loadRecorder(); h.recorder = new Recorder();
  return { ...h, added, calls, mixedTrack };
}

test('关闭网页声音且无麦克风时，音乐仍通过单个混音音轨编码并随暂停、停止释放', async t => {
  const h = await musicHarness(t);
  await h.recorder.start(h.stream, { audio: false, microphone: false, music: { id: 'song', volume: .2, loop: true } });
  assert.deepEqual(h.added, [h.mixedTrack]); assert.equal(h.calls.filter(call => call === 'context').length, 1);
  assert.equal(h.recorder.record.music.id, 'song'); assert.equal(h.recorder.state.music.playing, true);
  h.recorder.mediaRecorder.pause = function () { this.state = 'paused'; }; h.recorder.mediaRecorder.requestData = () => {};
  h.recorder.pause(); h.recorder.resume(); await h.recorder.controlMusic('volume', .85);
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'pause-music' && call[1] === true));
  assert.ok(h.calls.some(call => Array.isArray(call) && call[0] === 'pause-music' && call[1] === false));
  assert.equal(h.recorder.state.music.volume, .85);
  h.recorder.stop(); await tick(); assert.equal(h.mixedTrack.stopped, true);
  assert.equal(h.calls.filter(call => call === 'close-music').length, 1); assert.equal(h.calls.filter(call => call === 'close-context').length, 1);
});

test('音乐启动失败终结记录并释放所有采集，不能假装无声成功', async t => {
  let closed = false;
  const h = await musicHarness(t, async () => ({ snapshot: () => ({ id: 'song', name: 'test', volume: .2, loop: true }),
    start: async () => { throw new Error('music playback denied'); }, close: () => { closed = true; } }));
  await assert.rejects(h.recorder.start(h.stream, { audio: false, music: { id: 'song', volume: .2, loop: true } }), /music playback denied/);
  assert.equal(h.recorder.state.status, 'error'); assert.equal(h.track.readyState, 'ended'); assert.equal(closed, true);
  assert.equal(h.persisted.get(h.savedRecords[0].id).status, 'error');
});

test('取消期间迟到的音乐准备资源会关闭，不允许旧资源继续播放或覆盖新会话', async t => {
  let resolveMusic, closed = false, played = false;
  const h = await musicHarness(t, () => new Promise(resolve => { resolveMusic = resolve; }));
  const pending = h.recorder.start(h.stream, { music: { id: 'song', volume: .2, loop: true } });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  for (let i = 0; i < 20 && !resolveMusic; i++) await tick();
  assert.ok(resolveMusic); h.recorder.stop(); await rejected;
  resolveMusic({ close: () => { closed = true; }, start: async () => { played = true; } }); await tick();
  assert.equal(closed, true); assert.equal(played, false); assert.equal(h.track.readyState, 'ended');
});

test('积压片段集中完成不会刷屏，诊断最多每秒进度一次且终态完整落盘', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const h = await harness(t);
  now = 20;
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['a']) });
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['b']) });
  now = 40; h.resolveWrite(); await tick();
  assert.equal(h.published.filter(state => state.status === 'recording').length, 1);
  now = 1200; h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['c']) }); await tick();
  assert.equal(h.published.filter(state => state.status === 'recording').length, 2);
  now = 1220;
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['d']) });
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['e']) }); await tick();
  assert.equal(h.published.filter(state => state.status === 'recording').length, 2);
  h.recorder.stop(); await tick();
  const metrics = h.savedRecords.at(-1).performance.storage;
  assert.equal(metrics.chunksReceived, 6); assert.equal(metrics.chunkWritesCompleted, 6);
  assert.equal(metrics.peakPendingChunks, 3); assert.equal(metrics.peakPendingBytes, 7);
  assert.equal(metrics.chunkWriteMsTotal, 40); assert.equal(metrics.chunkWriteMsMax, 40);
  assert.equal(metrics.chunkIntervalCount, 5); assert.equal(metrics.chunkIntervalMsMax, 1180);
  assert.equal(h.recorder.state.status, 'complete');
  assert.deepEqual(h.recorder.state.performance.storage, metrics);
});

test('最后的元数据写入无响应时有界退出，不把未确认结果显示成功', async t => {
  const h = await harness(t, { start: false });
  let metadataWrites = 0;
  recorderTest.saveRecording = async () => { if (++metadataWrites > 1) return new Promise(() => {}); };
  const Recorder = await loadRecorder();
  const recorder = new Recorder();
  await recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['frame']) }); h.resolveWrite(); await tick();
  recorder.stop(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.track.readyState, 'ended'); assert.equal(recorder.state.status, 'interrupted');
  assert.match(recorder.state.error, /确认超时/); assert.ok(recorder.state.bytes > 0);
});

test('写入超时后重开录制，旧写入迟到不会修改新会话的统计或状态', async t => {
  const h = await harness(t); h.recorder.run.finalizeTimeoutMs = 15;
  h.recorder.stop(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.recorder.state.status, 'error');
  h.track.readyState = 'live'; await h.recorder.start(h.stream);
  const id = h.recorder.state.id; h.resolveWrite(); await tick();
  assert.equal(h.recorder.state.id, id); assert.equal(h.recorder.state.status, 'recording');
  assert.equal(h.recorder.record.bytes, 0); assert.equal(h.recorder.pendingBytes, 0);
  assert.equal(h.recorder.storagePerformance.chunkWritesCompleted, 0);
  h.recorder.stop(); await tick();
});

test('未收到有效媒体片段时保存失败记录，不发布complete', async t => {
  const h = await harness(t, { start: false });
  await h.recorder.start(h.stream);
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob([]) });
  h.recorder.stop(); await tick();
  const stored = h.persisted.get(h.recorder.state.id);
  assert.equal(h.recorder.state.status, 'error'); assert.equal(stored.status, 'error');
  assert.equal(stored.bytes, 0); assert.equal(stored.duration, 0);
  assert.match(h.recorder.state.error, /未产生有效视频片段/);
  assert.equal(h.published.some(state => state.status === 'complete'), false);
  assert.equal(h.track.readyState, 'ended');
});

test('最终元数据失败后持久化中断标记，不覆盖已确认字节和片段时长', async t => {
  const h = await harness(t, { start: false });
  const originalSave = recorderTest.saveRecording;
  let metadataWrites = 0;
  recorderTest.saveRecording = record => {
    if (++metadataWrites > 1) return Promise.reject(new Error('metadata unavailable'));
    return originalSave(record);
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await recorder.start(h.stream);
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['saved frame']) });
  h.resolveWrite(); await tick(); recorder.stop(); await tick();
  const stored = h.persisted.get(recorder.state.id), patch = h.patches.at(-1).patch;
  assert.equal(recorder.state.status, 'interrupted'); assert.equal(stored.status, 'interrupted');
  assert.equal(stored.bytes, 11); assert.equal(stored.duration, 1000);
  assert.equal(recorder.state.recoveryPending, false);
  assert.equal('bytes' in patch, false); assert.equal('duration' in patch, false);
  assert.match(stored.interruption, /metadata unavailable/);
});

test('积压后的部分保存使用片段到达时长，不使用停止或写入完成时间', async t => {
  const h = await harness(t, { start: false });
  let elapsedMs = 1000, releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  recorderTest.elapsed = () => elapsedMs;
  recorderTest.saveChunk = async (id, index, blob, record) => {
    if (!index) await first;
    if (index === 2) return new Promise(() => {});
    h.persisted.set(id, structuredClone(record));
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['one']) }); await tick();
  elapsedMs = 2000; recorder.mediaRecorder.ondataavailable({ data: new Blob(['two']) });
  elapsedMs = 10000; recorder.mediaRecorder.ondataavailable({ data: new Blob(['unsaved']) });
  recorder.stop(); releaseFirst(); await new Promise(resolve => setTimeout(resolve, 40));
  const stored = h.persisted.get(recorder.state.id);
  assert.equal(stored.status, 'interrupted'); assert.equal(stored.bytes, 6);
  assert.equal(stored.duration, 2000); assert.equal(recorder.state.duration, 2000);
  assert.equal(stored.attemptedDuration, 10000); assert.equal(recorder.state.recoveryPending, false);
});

test('迟到片段会修复旧记录终态及保留新增字节，不影响新会话', async t => {
  const h = await harness(t, { start: false });
  let resolveLate, elapsedMs = 1000;
  const late = new Promise(resolve => { resolveLate = resolve; });
  recorderTest.elapsed = () => elapsedMs;
  recorderTest.saveChunk = async (id, index, blob, record) => {
    if (index === 1) await late;
    h.persisted.set(id, structuredClone(record));
  };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['one']) }); await tick();
  elapsedMs = 2000; recorder.mediaRecorder.ondataavailable({ data: new Blob(['two']) }); await tick();
  const oldId = recorder.state.id;
  recorder.stop(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.persisted.get(oldId).status, 'interrupted'); assert.equal(h.persisted.get(oldId).bytes, 3);
  h.track.readyState = 'live'; await recorder.start(h.stream);
  const newId = recorder.state.id; resolveLate(); await tick();
  assert.equal(h.persisted.get(oldId).status, 'interrupted'); assert.equal(h.persisted.get(oldId).bytes, 6);
  assert.equal(h.persisted.get(oldId).duration, 2000);
  assert.equal(recorder.state.id, newId); assert.equal(recorder.state.status, 'recording');
  assert.equal(recorder.record.bytes, 0); assert.equal(h.persisted.get(newId).status, 'recording');
  recorder.stop(); await tick();
});

test('迟到最终元数据不能将旧中断状态恢复为complete，也不改新会话', async t => {
  const h = await harness(t, { start: false });
  const originalSave = recorderTest.saveRecording;
  let writes = 0, resolveLate;
  const late = new Promise(resolve => { resolveLate = resolve; });
  recorderTest.saveRecording = async record => { if (++writes === 2) await late; await originalSave(record); };
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['frame']) }); h.resolveWrite(); await tick();
  const oldId = recorder.state.id;
  recorder.stop(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(h.persisted.get(oldId).status, 'interrupted');
  h.track.readyState = 'live'; await recorder.start(h.stream);
  const newId = recorder.state.id; resolveLate(); await tick();
  assert.equal(h.persisted.get(oldId).status, 'interrupted');
  assert.equal(recorder.state.id, newId); assert.equal(recorder.state.status, 'recording');
  recorder.stop(); await tick();
});

test('终态补丁也无响应时有限等待，并通知后台仍需恢复协调', async t => {
  const h = await harness(t, { start: false });
  recorderTest.patchRecording = () => new Promise(() => {});
  const Recorder = await loadRecorder(), recorder = new Recorder();
  await recorder.start(h.stream, { finalizeTimeoutMs: 15 });
  recorder.mediaRecorder.ondataavailable({ data: new Blob(['frame']) }); await tick();
  recorder.stop(); await tick();
  assert.equal(h.track.readyState, 'ended'); assert.equal(recorder.state.released, true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(recorder.state.status, 'error'); assert.equal(recorder.state.recoveryPending, true);
});

test('显式MP4保存编码器实际MIME和容器，不沿用WebM元数据', async t => {
  const h = await harness(t, { start: false });
  await h.recorder.start(h.stream, { format: 'mp4' });
  h.recorder.mediaRecorder.ondataavailable({ data: new Blob(['mp4 frame']) }); h.resolveWrite(); await tick();
  h.recorder.stop(); await tick();
  const stored = h.persisted.get(h.recorder.state.id);
  assert.equal(stored.format, 'mp4'); assert.match(stored.mimeType, /^video\/mp4;codecs=avc1/);
  assert.equal(stored.status, 'complete');
});

test('显式MP4不受支持时清晰失败并释放来源，不自动降级WebM', async t => {
  const h = await harness(t, { start: false });
  MediaRecorder.isTypeSupported = type => type.startsWith('video/webm');
  await assert.rejects(h.recorder.start(h.stream, { format: 'mp4' }), /不支持.*MP4/);
  assert.equal(h.recorder.state.status, 'error'); assert.equal(h.track.readyState, 'ended');
  assert.equal(h.persisted.size, 0);
});
