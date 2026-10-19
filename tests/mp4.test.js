import test from 'node:test';
import assert from 'node:assert/strict';
import { convertToMp4 } from '../lib/mp4.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 40; i++) { if (predicate()) return; await tick(); }
  throw new Error('Expected conversion phase was not reached');
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const mp4 = () => new Blob([new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]), new Uint8Array(8)], { type: 'video/mp4' });

function harness(t, options = {}) {
  const calls = { created: 0, removed: 0, revoked: 0, paused: 0, stopped: 0, aborted: 0, written: 0, close: 0, file: 0 };
  const controller = new AbortController(), tracks = [{ kind: 'video', stop() { calls.stopped++; } }, { kind: 'audio', stop() { calls.stopped++; } }];
  const stream = { getVideoTracks: () => tracks.filter(track => track.kind === 'video'), getAudioTracks: () => tracks.filter(track => track.kind === 'audio'), getTracks: () => tracks };
  const video = { currentTime: 0, duration: 2, videoWidth: 1280, videoHeight: 720, ended: false,
    captureStream: () => stream,
    load() { if (this.src && options.loaded !== false) queueMicrotask(() => this.onloadeddata?.()); },
    play: async () => {}, pause() { calls.paused++; },
    removeAttribute() { this.src = null; }, remove() { calls.removed++; }
  };
  const writable = {
    async write() { calls.written++; if (options.write) await options.write.promise; },
    async close() { calls.close++; if (options.close) await options.close.promise; },
    async abort() { calls.aborted++; }
  };
  const directory = { async getFileHandle() { return {
    async createWritable() { calls.open = (calls.open || 0) + 1; if (options.open) await options.open.promise; return writable; },
    async getFile() { calls.file++; if (options.file) await options.file.promise; return mp4(); }
  }; }, async removeEntry() { calls.removedFile = true; } };
  const storage = { async getDirectory() { if (options.directory) await options.directory.promise; return { getDirectoryHandle: async () => directory }; } };
  const urls = { createObjectURL() { calls.created++; return 'blob:mp4-test'; }, revokeObjectURL() { calls.revoked++; } };
  const previous = { document: globalThis.document, MediaRecorder: globalThis.MediaRecorder };
  let recorder;
  globalThis.document = { createElement: () => video };
  globalThis.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, settings) { recorder = this; this.mimeType = settings.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  };
  t.after(() => Object.assign(globalThis, previous));
  const result = convertToMp4('blob:original', { width: 1280, height: 720, fps: 30, duration: 2000, ...options.recordData }, {
    storage: options.blob ? null : storage, urls, signal: controller.signal, token: 'conversion-test', cleanupTimeoutMs: options.cleanupTimeoutMs ?? 1000, timeoutMs: options.timeoutMs ?? 15000
  });
  // Attach the observer before any injected failure, so the test does not
  // manufacture unhandled-rejection noise while advancing media callbacks.
  const outcome = result.then(value => ({ value }), error => ({ error }));
  const data = (blob = mp4()) => recorder.ondataavailable({ data: blob });
  const end = () => { video.ended = true; video.currentTime = video.duration; video.onended(); };
  return { result, outcome, controller, calls, video, data, end, recorder: () => recorder };
}

test('MP4编码onstop后才发生的写盘失败仍拒绝，不生成下载URL', async t => {
  const write = deferred(), h = harness(t, { write }); await until(() => h.recorder()?.state === 'recording');
  h.data(); await until(() => h.calls.written === 1); h.end(); await tick();
  write.reject(new Error('disk full after stop'));
  const { error } = await h.outcome;
  assert.match(error?.message || '', /disk full after stop/); assert.equal(h.calls.created, 0);
  assert.equal(h.calls.aborted, 1); assert.equal(h.calls.removedFile, true); assert.equal(h.calls.stopped, 2);
});

test('MP4最终文件提交失败不会返回成功', async t => {
  const close = deferred(), h = harness(t, { close }); await until(() => h.recorder()?.state === 'recording');
  h.data(); h.end(); await until(() => h.calls.close === 1); close.reject(new Error('commit rejected'));
  const { error } = await h.outcome;
  assert.match(error?.message || '', /commit rejected/); assert.equal(h.calls.created, 0); assert.equal(h.calls.removedFile, true);
});

test('MP4没有任何有效编码数据时失败并清理临时文件', async t => {
  const h = harness(t); await until(() => h.recorder()?.state === 'recording'); h.end();
  const { error } = await h.outcome;
  assert.match(error?.message || '', /没有输出有效数据/); assert.equal(h.calls.created, 0); assert.equal(h.calls.removedFile, true);
});

test('来源尚未播放结束而编码器自行停止时拒绝不完整MP4', async t => {
  const h = harness(t); await until(() => h.recorder()?.state === 'recording'); h.data(); h.recorder().stop();
  const { error } = await h.outcome;
  assert.match(error?.message || '', /视频结束前中断/); assert.equal(h.calls.created, 0); assert.equal(h.calls.stopped, 2);
});

test('编码进行中取消会停止媒体及删除临时文件', async t => {
  const h = harness(t); await until(() => h.recorder()?.state === 'recording'); h.data(); h.controller.abort();
  const { error } = await h.outcome;
  assert.equal(error?.name, 'AbortError'); assert.equal(h.calls.created, 0); assert.equal(h.calls.stopped, 2); assert.equal(h.calls.removedFile, true);
});

test('编码完成但最终文件正在close时取消，不能返回成功资源', async t => {
  const close = deferred(), h = harness(t, { close }); await until(() => h.recorder()?.state === 'recording');
  h.data(); h.end(); await until(() => h.calls.close === 1); h.controller.abort(); close.resolve();
  const result = await h.outcome;
  // Release a mistakenly returned resource too, keeping failure isolated.
  await result.value?.cleanup();
  assert.equal(result.error?.name, 'AbortError'); assert.equal(h.calls.created, 0); assert.equal(h.calls.removedFile, true);
});

test('最终文件正在getFile时取消，不能返回成功资源', async t => {
  const file = deferred(), h = harness(t, { file }); await until(() => h.recorder()?.state === 'recording');
  h.data(); h.end(); await until(() => h.calls.file === 1); h.controller.abort(); file.resolve();
  const result = await h.outcome; await result.value?.cleanup();
  assert.equal(result.error?.name, 'AbortError'); assert.equal(h.calls.created, 0);
});

test('读取来源期间取消无需等待loadeddata，及时释放视频元素', async t => {
  const h = harness(t, { loaded: false }); await until(() => !!h.video.src);
  let settled = false; h.outcome.then(() => { settled = true; }); h.controller.abort(); await tick();
  const settledBeforeLoadedData = settled;
  h.video.onloadeddata?.(); const result = await h.outcome;
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(settledBeforeLoadedData, true); assert.equal(h.calls.created, 0); assert.ok(h.calls.removed > 0);
});

test('OPFS来源目录等待期间取消无需等待存储返回，迟到结果不启动转换', async t => {
  const directory = deferred(), h = harness(t, { directory });
  let settled = false; h.outcome.then(() => { settled = true; }); h.controller.abort(); await tick();
  const settledBeforeDirectory = settled;
  directory.resolve(); const result = await h.outcome;
  assert.equal(result.error?.name, 'AbortError'); assert.equal(settledBeforeDirectory, true);
  assert.equal(h.recorder(), undefined); assert.equal(h.calls.created, 0);
});

test('打开OPFS writer期间取消及时返回，迟到writer仍被abort清理', async t => {
  const open = deferred(), h = harness(t, { open, cleanupTimeoutMs: 5 }); await until(() => h.calls.open === 1);
  let settled = false; h.outcome.then(() => { settled = true; }); h.controller.abort(); await h.outcome;
  const settledBeforeWriter = settled;
  open.resolve(); const result = await h.outcome; await tick();
  assert.equal(result.error?.name, 'AbortError'); assert.equal(settledBeforeWriter, true);
  assert.equal(h.calls.aborted, 1); assert.equal(h.calls.removedFile, true); assert.equal(h.recorder(), undefined);
});

test('播放被暂停且长期无进度时明确失败，不输出静止的完整MP4', async t => {
  let interval, now = 0;
  t.mock.method(globalThis, 'setInterval', callback => { interval = callback; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  t.mock.method(performance, 'now', () => now);
  const h = harness(t); await until(() => h.recorder()?.state === 'recording');
  h.data(); h.video.pause(); now = 61000; interval();
  const { error } = await h.outcome;
  assert.match(error?.message || '', /长时间没有进度/); assert.equal(h.calls.created, 0); assert.equal(h.calls.stopped, 2);
});

test('成功MP4只返回真实ftyp容器，cleanup幂等释放资源', async t => {
  const h = harness(t, { blob: true }); await until(() => h.recorder()?.state === 'recording'); h.data(); h.end();
  const { value, error } = await h.outcome;
  assert.equal(error, undefined); assert.equal(value.storage, 'blob'); assert.match(value.mimeType, /^video\/mp4/);
  assert.equal(value.bytes, 20); assert.equal(h.calls.created, 1);
  await value.cleanup(); await value.cleanup(); assert.equal(h.calls.revoked, 1);
});

test('MP4单次写入卡住时不用等播放结束才超时，原生迟到写入结束后再删缓存',async t=>{
  const write=deferred(),h=harness(t,{write,timeoutMs:15,cleanupTimeoutMs:5});
  t.after(async()=>{write.resolve();await tick();});
  await until(()=>h.recorder()?.state==='recording');h.data();
  const {error}=await h.outcome;assert.equal(error?.name,'TimeoutError');assert.equal(h.calls.created,0);assert.equal(h.calls.stopped,2);
  assert.notEqual(h.calls.removedFile,true);write.resolve();await tick();assert.equal(h.calls.removedFile,true);
});
test('MP4兼容内存结果达到预算即停止，不能累计整个长视频',async t=>{
  const h=harness(t,{blob:true});await until(()=>h.recorder()?.state==='recording');
  h.data({size:32*1024*1024+1});const {error}=await h.outcome;
  assert.match(error?.message,/预算/);assert.equal(h.calls.created,0);assert.equal(h.calls.stopped,2);
});
test('缺少文件暂存时大源视频在解码开始前拒绝转换',async t=>{
  const h=harness(t,{blob:true,recordData:{bytes:32*1024*1024+1}});const {error}=await h.outcome;
  assert.match(error?.message,/低内存转换/);assert.equal(h.recorder(),undefined);assert.equal(h.calls.created,0);
});
