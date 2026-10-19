import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionForMime } from '../lib/media-format.js';
const source = (await readFile(new URL('../lib/preview.js', import.meta.url), 'utf8')).replace(/^import \{ bounded \}.*;\r?\n/m, `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n`);

async function harness(t) {
  const h = { record: { id: 'record', bytes: 40 * 1024 * 1024, mimeType: 'video/webm', status: 'complete' },
    files: new Map(), held: new Set(), writes: 0, blobReads: 0, revokes: [], aborts: 0, closes: 0, removes: [] };
  const dependencies = { extensionForMime, getRecording: async () => h.record,
    recordingBlob: async () => { h.blobReads++; return new Blob(['small']); },
    writeRecordingTo: async (id, writer, { signal, onProgress }) => {
      for (let i = 1; i <= 4; i++) {
        signal?.throwIfAborted(); await writer.write({ size: h.record.bytes / 4 }); h.writes++;
        onProgress?.(h.record.bytes * i / 4, h.record.bytes);
        if (h.gate) await h.gate.promise;
        if (h.abortAt === i) h.controller.abort();
      }
    } };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'previewTest');
  globalThis.previewTest = dependencies;
  t.after(() => descriptor ? Object.defineProperty(globalThis, 'previewTest', descriptor) : delete globalThis.previewTest);
  h.api = await import('data:text/javascript;base64,' + Buffer.from('const {getRecording,recordingBlob,writeRecordingTo,extensionForMime}=globalThis.previewTest;\n' + `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n` + `import { createFileResource, temporaryLockName } from '${new URL('../lib/file-resource.js', import.meta.url).href}';\nimport { MEMORY_VIDEO_LIMIT, ensureStorageBudget, estimateMp4Bytes } from '${new URL('../lib/storage-budget.js', import.meta.url).href}';\n` + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random()).toString('base64'));
  const directory = h.directory = {
    async *entries() { for (const [name] of h.files) yield [name, { kind: 'file', getFile: async () => h.files.get(name) }]; },
    async getFileHandle(name) {
      if (h.fileGate) await h.fileGate.promise;
      h.files.set(name, { size: 0, lastModified: Date.now() }); let bytes = 0;
      return { async createWritable() {
        if (h.writerGate) await h.writerGate.promise;
        return { async write(blob) { if (h.writeGate) await h.writeGate.promise; if (h.writeError) throw h.writeError; bytes += blob.size; },
          async close() { if (h.closeGate) await h.closeGate.promise; h.closes++; if (h.closeError) throw h.closeError; h.files.set(name, { size: h.badSize ? bytes - 1 : bytes, lastModified: Date.now() }); },
          async abort() { h.aborts++; if (h.abortGate) await h.abortGate.promise; } };
      }, async getFile() { if (h.afterCloseAbort) h.controller.abort(); return h.files.get(name); } };
    },
    async removeEntry(name) { h.removes.push(name); h.files.delete(name); }
  };
  h.storage = { getDirectory: async () => ({ getDirectoryHandle: async name => { assert.equal(name, 'yinglu-previews'); return directory; } }) };
  h.locks = { async request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (h.held.has(name)) { assert.equal(options.ifAvailable, true); return callback(null); }
    h.held.add(name);
    try { return await callback({ name }); } finally { h.held.delete(name); }
  } };
  h.urls = { createObjectURL(value) { h.urlValue = value; return 'blob:preview-test'; }, revokeObjectURL: url => h.revokes.push(url) };
  h.controller = new AbortController();
  h.prepare = extra => h.api.prepareRecordingPreview('record', { storage: h.storage, locks: h.locks, urls: h.urls, signal: h.controller.signal, ...extra });
  return h;
}

test('长视频逐片写文件并用File URL回看，不合成完整Blob，清理同时释放文件和锁', async t => {
  const h = await harness(t), resource = await h.prepare();
  assert.equal(resource.storage, 'opfs'); assert.equal(h.blobReads, 0); assert.equal(h.writes, 4);
  assert.equal(h.closes, 1); assert.equal(h.urlValue.size, h.record.bytes); assert.equal(h.held.size, 1);
  await resource.cleanup(); await resource.cleanup();
  assert.equal(h.files.size, 0); assert.equal(h.held.size, 0); assert.equal(h.revokes.length, 1);
});

test('32MiB以内保留轻量Blob路径，超出一个字节就使用文件路径', async t => {
  const h = await harness(t); h.record.bytes = 32 * 1024 * 1024;
  const small = await h.prepare(); assert.equal(small.storage, 'blob'); assert.equal(h.blobReads, 1); assert.equal(h.writes, 0); await small.cleanup();
  h.record.bytes++; const large = await h.prepare();
  assert.equal(large.storage, 'opfs'); assert.equal(h.blobReads, 1); await large.cleanup();
});

test('不支持OPFS或临时空间不足时不静默回退大Blob，原视频保持不变', async t => {
  const h = await harness(t), original = { ...h.record };
  await assert.rejects(h.prepare({ storage: {} }), /直接保存文件/); assert.equal(h.blobReads, 0);
  h.writeError = new DOMException('full', 'QuotaExceededError');
  await assert.rejects(h.prepare(), /存储空间/);
  assert.equal(h.files.size, 0); assert.equal(h.held.size, 0); assert.equal(h.aborts, 1); assert.equal(h.blobReads, 0);
  assert.deepEqual(h.record, original);
});

test('载入途中取消停止后续片段并释放未完成文件', async t => {
  const h = await harness(t); h.abortAt = 1;
  await assert.rejects(h.prepare(), { name: 'AbortError' });
  assert.equal(h.writes, 1); assert.equal(h.aborts, 1); assert.equal(h.files.size, 0); assert.equal(h.held.size, 0);
  assert.equal(h.urlValue, undefined);
});

test('文件提交失败、关闭后取消或缓存大小不符均不留下可用URL和临时文件', async t => {
  const h = await harness(t); h.closeError = new Error('close failed');
  await assert.rejects(h.prepare(), /close failed/); assert.equal(h.files.size, 0);
  h.closeError = null; h.badSize = true; await assert.rejects(h.prepare(), /不完整/); assert.equal(h.files.size, 0);
  h.badSize = false; h.afterCloseAbort = true; await assert.rejects(h.prepare(), { name: 'AbortError' });
  assert.equal(h.urlValue, undefined); assert.equal(h.files.size, 0); assert.equal(h.held.size, 0);
});

test('过期预览清理跳过其他页面持有的锁、近期文件和不属于预览的文件', async t => {
  const h = await harness(t), now = Date.now();
  const dead = 'preview-1-dead.webm', live = 'preview-1-live.mp4', recent = 'preview-2-recent.webm';
  h.files.set(dead, { lastModified: now - 90000000 }); h.files.set(live, { lastModified: now - 90000000 });
  h.files.set(recent, { lastModified: now }); h.files.set('unrelated.mp4', { lastModified: 0 });
  h.held.add(`yinglu-preview:${live}`);
  await h.api.cleanupPreviewFiles({ storage: h.storage, locks: h.locks, now });
  assert.deepEqual([...h.files.keys()], [live, recent, 'unrelated.mp4']);
  h.held.delete(`yinglu-preview:${live}`);
  await h.api.cleanupPreviewFiles({ storage: h.storage, locks: h.locks, now });
  assert.deepEqual([...h.files.keys()], [recent, 'unrelated.mp4']);
});

test('没有跨页锁时不回收可能仍使用的文件，当前预览依旧可以正常释放', async t => {
  const h = await harness(t); h.files.set('preview-1-live.webm', { lastModified: 0 });
  // undefined uses the runtime default, which can include Node's own Web Locks.
  const preview = await h.prepare({ locks: null }); await preview.cleanup();
  assert.equal(h.files.size, 1); assert.ok(h.files.has('preview-1-live.webm'));
});

test('下次载入立即回收未持锁的崩溃缓存，即使它刚刚创建，保留活跃页面缓存', async t => {
  const h = await harness(t);
  h.files.set('preview-1-crashed.webm', { size: 10, lastModified: Date.now() });
  h.files.set('preview-1-live.webm', { size: 10, lastModified: Date.now() });
  h.held.add('yinglu-preview:preview-1-live.webm');
  const preview = await h.prepare();
  assert.equal(h.files.has('preview-1-crashed.webm'), false); assert.equal(h.files.has('preview-1-live.webm'), true);
  await preview.cleanup(); assert.equal(h.files.size, 1);
});

test('读取开始前取消不触碰磁盘或视频数据', async t => {
  const h = await harness(t); h.controller.abort();
  await assert.rejects(h.prepare(), { name: 'AbortError' });
  assert.equal(h.blobReads, 0); assert.equal(h.writes, 0); assert.equal(h.files.size, 0);
});

const deferred = () => { let resolve; const promise = new Promise(done => {resolve=done;}); return {promise,resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const stage of ['fileGate','writerGate','writeGate','closeGate']) {
  test(`原生${stage}挂起时取消及时返回，迟到提交仍持锁并被清理`, async t => {
    const h = await harness(t); h[stage] = deferred();
    const promise = h.prepare({cleanupTimeoutMs:5}); await tick();
    assert.equal(h.held.size,1); h.controller.abort();
    await assert.rejects(promise,{name:'AbortError'});
    assert.equal(h.held.size,1); assert.equal(h.urlValue,undefined);
    h[stage].resolve(); await tick(); await tick();
    assert.equal(h.files.size,0); assert.equal(h.held.size,0);
    if (stage==='writerGate') assert.equal(h.aborts,1);
  });
}
test('单次写入无进展会超时，迟到写入不能恢复预览，取消清理本身也有等待上限', async t => {
  const h = await harness(t); h.writeGate = deferred(); h.abortGate = deferred();
  await assert.rejects(h.prepare({timeoutMs:15,cleanupTimeoutMs:5}),{name:'TimeoutError'});
  assert.equal(h.aborts,1); assert.equal(h.held.size,1); assert.equal(h.urlValue,undefined);
  h.writeGate.resolve(); await tick(); assert.equal(h.held.size,1);
  h.abortGate.resolve(); await tick(); assert.equal(h.files.size,0); assert.equal(h.held.size,0);
});
test('元数据和目录挂起也可取消或超时，不创建临时URL', async t => {
  const h = await harness(t);
  h.storage.getDirectory = () => new Promise(()=>{});
  const pending = h.prepare(); await tick(); h.controller.abort();
  await assert.rejects(pending,{name:'AbortError'}); assert.equal(h.held.size,0);
  h.controller = new AbortController();
  await assert.rejects(h.prepare({timeoutMs:15}),{name:'TimeoutError'});
});

test('取消后底层写入未结束时拒绝叠加新的预览，清理完成后允许重试',async t=>{
  const h=await harness(t);h.writeGate=deferred();
  const pending=h.prepare({cleanupTimeoutMs:5});await tick();h.controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await assert.rejects(h.prepare({signal:undefined}),/上一段预览/);assert.equal(h.files.size,1);
  h.writeGate.resolve();await tick();await tick();h.writeGate=null;
  const preview=await h.prepare({signal:undefined});await preview.cleanup();await preview.cleanup();
  const again=await h.prepare({signal:undefined});await again.cleanup();assert.equal(h.files.size,0);
});
