import { createFileResource } from '../lib/file-resource.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionForMime, mediaFormat } from '../lib/media-format.js';
const source = await readFile(new URL('../lib/export.js', import.meta.url), 'utf8');
const pageSource = await readFile(new URL('../exporter.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function moduleHarness(t) {
  const h = { calls: [], fallback: 0, chunks: [new Blob(['first']), new Blob(['second'])], files: new Map(), record: { id: 'r1', createdAt: 1735689600000, title: '演示', status: 'complete', bytes: 11, mimeType: 'video/webm' } };
  const saved = globalThis.exportTest;
  globalThis.exportTest = {
    getRecording: async () => h.record, extensionForMime, mediaFormat,
    writeRecordingTo: async (id, writable, options) => {
      for (const [index, chunk] of h.chunks.entries()) {
        options.signal?.throwIfAborted(); await writable.write(chunk);
        options.onProgress(chunk.size);
        if (h.abortAfter === index) h.controller.abort();
      }
      return h.chunks.reduce((total, chunk) => total + chunk.size, 0);
    },
    recordingBlob: async () => { h.fallback++; return new Blob(h.chunks, { type: 'video/webm' }); }
  };
  t.after(() => { if (saved === undefined) delete globalThis.exportTest; else globalThis.exportTest = saved; });
  const code = 'const {getRecording,writeRecordingTo,recordingBlob,extensionForMime,mediaFormat} = globalThis.exportTest;\n' + `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n` + `import { createFileResource, temporaryLockName } from '${new URL('../lib/file-resource.js', import.meta.url).href}';\nimport { MEMORY_VIDEO_LIMIT, ensureStorageBudget, estimateMp4Bytes } from '${new URL('../lib/storage-budget.js', import.meta.url).href}';\n` + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  h.api = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  h.urls = {
    createObjectURL(value) { h.calls.push('url'); h.urlValue = value; return 'blob:test/export'; },
    revokeObjectURL(value) { h.calls.push('revoke'); h.revoked = value; }
  };
  const directory = {
    async getFileHandle(name) {
      if (h.fileGate) await h.fileGate.promise;
      h.calls.push('file'); h.files.set(name, undefined);
      let closed = false; const chunks = [];
      return {
        async createWritable() {
          h.calls.push('writer'); if (h.writerGate) await h.writerGate.promise;
          return {
            async write(blob) { h.calls.push('write'); if (h.writeGate) await h.writeGate.promise; if (h.writeError) throw h.writeError; chunks.push(blob); },
            async close() { h.calls.push('close'); if (h.closeGate) await h.closeGate.promise; if (h.closeError) throw h.closeError; closed = true; h.files.set(name, new Blob(chunks)); },
            async abort() { h.calls.push('abort'); }
          };
        },
        async getFile() { h.calls.push('getFile'); assert.equal(closed, true); return h.files.get(name); }
      };
    },
    async removeEntry(name) { h.calls.push('remove'); h.files.delete(name); }
  };
  h.storage = { async getDirectory() {
    h.calls.push('root'); if (h.rootGate) await h.rootGate.promise; if (h.storageError) throw h.storageError;
    return { async getDirectoryHandle(name) { assert.equal(name, 'yinglu-exports'); return directory; } };
  } };
  return h;
}

test('自动导出逐段暂存，下载结束前保留文件和 URL，结束清理可重复调用', async t => {
  const h = await moduleHarness(t);
  const prepared = await h.api.prepareRecordingExport('r1', { storage: h.storage, urls: h.urls });
  assert.equal(prepared.storage, 'opfs'); assert.equal(h.fallback, 0);
  assert.equal(await h.urlValue.text(), 'firstsecond'); assert.equal(h.files.size, 1);
  assert.deepEqual(h.calls, ['root', 'file', 'writer', 'write', 'write', 'close', 'getFile', 'url']);
  await prepared.cleanup(); await prepared.cleanup();
  assert.equal(h.files.size, 0); assert.equal(h.revoked, prepared.url);
  assert.equal(h.calls.filter(call => call === 'remove').length, 1);
  assert.equal(h.calls.filter(call => call === 'revoke').length, 1);
});

test('分段写入或提交失败会中止临时写入并清理，保留数据库副本', async t => {
  for (const failure of ['writeError', 'closeError']) {
    const h = await moduleHarness(t); h[failure] = new Error('disk full');
    await assert.rejects(h.api.prepareRecordingExport('r1', { storage: h.storage, urls: h.urls }), /disk full/);
    assert.equal(h.files.size, 0); assert.equal(h.calls.includes('abort'), true);
    assert.equal(h.calls.includes('url'), false); assert.equal(h.fallback, 0);
    assert.equal(h.record.id, 'r1');
  }
});

test('无 OPFS 或环境拒绝使用时回退 Blob，并明确标明兼容模式', async t => {
  for (const available of [false, true]) {
    const h = await moduleHarness(t); h.storageError = new DOMException('unsupported context', 'SecurityError');
    const prepared = await h.api.prepareRecordingExport('r1', { storage: available ? h.storage : {}, urls: h.urls });
    assert.equal(prepared.storage, 'blob'); assert.equal(h.fallback, 1); assert.equal(await h.urlValue.text(), 'firstsecond');
    await prepared.cleanup(); assert.equal(h.revoked, prepared.url);
  }
});

test('配额失败不会再组装完整 Blob，取消会清理已写入的临时文件', async t => {
  const h = await moduleHarness(t); h.storageError = new DOMException('quota', 'QuotaExceededError');
  await assert.rejects(h.api.prepareRecordingExport('r1', { storage: h.storage, urls: h.urls }), { name: 'QuotaExceededError' });
  assert.equal(h.fallback, 0);
  h.storageError = undefined; h.controller = new AbortController(); h.abortAfter = 0;
  await assert.rejects(h.api.prepareRecordingExport('r1', { storage: h.storage, urls: h.urls, signal: h.controller.signal }), { name: 'AbortError' });
  assert.equal(h.files.size, 0); assert.equal(h.calls.includes('abort'), true);
});

test('自动导出拒绝仍在录制的记录，文件名不能引入路径或 Windows 非法字符', async t => {
  const h = await moduleHarness(t); h.record.status = 'recording';
  await assert.rejects(h.api.prepareRecordingExport('r1'), /尚未结束/);
  const filename = h.api.recordingFilename({ title: '../CON:<bad>\\a/b|?*\n‮', createdAt: 1735689600000 });
  assert.equal(/[<>:"/\\|?*\u0000-\u001f\u202a-\u202e]/.test(filename), false);
  assert.equal(filename.endsWith('.webm'), true); assert.equal(filename.startsWith('映录-2025-01-01_00-00-00-'), true);
});

async function pageHarness(t, { prepareFailure = false, pendingReady = false } = {}) {
  const h = { sent: [], cleanups: 0, readyAck: undefined };
  if (pendingReady) h.readyAck = new Promise(resolve => { h.acknowledge = resolve; });
  let listener;
  const saved = {};
  const resource = { url: 'blob:test/export', filename: '映录.webm', storage: 'opfs', async cleanup() { h.cleanups++; } };
  const values = {
    location: { search: '?id=r1&token=token1' }, document: { getElementById: () => ({ textContent: '' }) }, addEventListener() {},
    exportPageTest: { prepareRecordingExport: async () => { if (prepareFailure) throw new Error('disk full'); return resource; } },
    chrome: { tabs: { getCurrent: async () => ({ id: 7 }) }, runtime: { id: 'test', onMessage: { addListener: fn => listener = fn }, sendMessage: async message => {
      h.sent.push(message);
      if (message.type === 'EXPORT_READY' && h.readyAck) return h.readyAck;
      return { ok: true };
    } } }
  };
  for (const [key, value] of Object.entries(values)) { saved[key] = Object.getOwnPropertyDescriptor(globalThis, key); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  const code = 'const {prepareRecordingExport}=globalThis.exportPageTest;\n' + `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\nimport { pendingFileCleanupCount } from '${new URL('../lib/file-resource.js', import.meta.url).href}';\n` + pageSource.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')); await tick();
  h.finish = () => new Promise(resolve => listener({ target: 'exporter', type: 'EXPORT_FINISH', recordingId: 'r1', token: 'token1' }, { id: 'test' }, resolve));
  return h;
}

test('导出页发出就绪消息后保持 URL 资源，收到后台结束指令才清理', async t => {
  const h = await pageHarness(t);
  assert.equal(h.sent.find(message => message.type === 'EXPORT_READY').recordingId, 'r1'); assert.equal(h.cleanups, 0);
  assert.deepEqual(await h.finish(), { ok: true }); assert.equal(h.cleanups, 1);
});

test('准备失败向后台报告真实错误，后台仍可结束并关闭导出页', async t => {
  const h = await pageHarness(t, { prepareFailure: true });
  assert.equal(h.sent[0].type, 'EXPORT_ERROR'); assert.equal(h.sent[0].error, 'disk full');
  assert.deepEqual(await h.finish(), { ok: true });
});

test('下载过快在 READY 回执前结束也能清理，不与后台互相等待', { timeout: 1000 }, async t => {
  const h = await pageHarness(t, { pendingReady: true });
  assert.equal(h.sent.some(message => message.type === 'EXPORT_READY'), true); assert.equal(h.cleanups, 0);
  assert.deepEqual(await h.finish(), { ok: true }); assert.equal(h.cleanups, 1);
  h.acknowledge({ ok: true });
});

test('MP4导出调用转换hook并组合清理，原始录制仍是WebM', async t => {
  const h = await moduleHarness(t); h.record.mimeType = 'video/webm'; let convertedCleanup = 0;
  const prepared = await h.api.prepareRecordingExport('r1', { storage: h.storage, urls: h.urls, token: 'owner', format: 'mp4',
    convertToMp4: async (url, record, options) => {
      assert.equal(url, 'blob:test/export'); assert.equal(record.mimeType, 'video/webm'); assert.equal(options.token, 'owner');
      return { url: 'blob:test/mp4', storage: 'opfs', cleanup: async () => { convertedCleanup++; } };
    } });
  assert.equal(prepared.format, 'mp4'); assert.equal(prepared.filename.endsWith('.mp4'), true); assert.equal(h.record.mimeType, 'video/webm');
  await prepared.cleanup(); await prepared.cleanup(); assert.equal(convertedCleanup, 1); assert.equal(h.files.size, 0);
});

test('孤儿清理只处理所属目录内超龄或已结束文件，保护活跃任务和未知文件', async t => {
  const h = await moduleHarness(t), now = 200000000, removed = [];
  const files = [
    ['auto-1-active-source.webm', 0], ['convert-active.mp4', 0], ['auto-2-done.webm', now],
    ['convert-done.mp4', now], ['auto-old-owner.webm', 0], ['auto-recent-owner.webm', now], ['unrelated.webm', 0]
  ];
  const storage = { getDirectory: async () => ({ getDirectoryHandle: async name => {
    assert.equal(name, 'yinglu-exports');
    return { async *entries() { for (const [name, lastModified] of files) yield [name, { kind: 'file', getFile: async () => ({ lastModified }) }]; },
      removeEntry: async name => removed.push(name) };
  } }) };
  const summary = await h.api.cleanupExportTemporaryFiles({ storage, activeTokens: ['active'], finishedTokens: ['done'], now });
  assert.deepEqual(removed, ['auto-2-done.webm', 'convert-done.mp4', 'auto-old-owner.webm']);
  assert.equal(summary.errors.length, 0);
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
test('导出目录挂起时取消及时返回，迟到目录不再创建文件',async t=>{
  const h=await moduleHarness(t);h.rootGate=deferred();const controller=new AbortController();
  const pending=h.api.prepareRecordingExport('r1',{storage:h.storage,signal:controller.signal,cleanupTimeoutMs:5});await tick();controller.abort();
  await assert.rejects(pending,{name:'AbortError'});h.rootGate.resolve();await tick();
  assert.equal(h.calls.includes('file'),false);assert.equal(h.calls.includes('url'),false);
});
for(const stage of ['fileGate','writerGate','writeGate','closeGate'])test(`导出${stage}挂起时可取消，迟到文件提交清理后才允许重试`,async t=>{
  const h=await moduleHarness(t);h[stage]=deferred();const controller=new AbortController();
  const options={storage:h.storage,urls:h.urls,cleanupTimeoutMs:5};
  const pending=h.api.prepareRecordingExport('r1',{...options,signal:controller.signal});await tick();controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(h.calls.includes('url'),false);
  await assert.rejects(h.api.prepareRecordingExport('r1',options),/上一项导出/);
  h[stage].resolve();await tick();await tick();h[stage]=null;
  assert.equal(h.files.size,0);const resource=await h.api.prepareRecordingExport('r1',options);await resource.cleanup();
});
test('大于32MiB的导出缺少文件能力时拒绝全量Blob，小文件保留兼容路径',async t=>{
  const h=await moduleHarness(t);h.record.bytes=32*1024*1024+1;
  await assert.rejects(h.api.prepareRecordingExport('r1',{storage:{}}),/低内存|直接保存/);assert.equal(h.fallback,0);
  h.storageError=new DOMException('no','NotSupportedError');
  await assert.rejects(h.api.prepareRecordingExport('r1',{storage:h.storage}),/低内存|直接保存/);assert.equal(h.fallback,0);
  h.record.bytes=11;const resource=await h.api.prepareRecordingExport('r1',{storage:{},urls:h.urls});assert.equal(h.fallback,1);await resource.cleanup();
});
test('暂存空间不足提前失败，不开始写文件或回退大Blob',async t=>{
  const h=await moduleHarness(t);h.record.bytes=40e6;h.storage.estimate=async()=>({usage:99e6,quota:100e6});
  await assert.rejects(h.api.prepareRecordingExport('r1',{storage:h.storage}),/空间不足/);
  assert.equal(h.calls.includes('file'),false);assert.equal(h.fallback,0);
});
test('导出单次文件提交无进展超时，迟到提交不能返回下载URL',async t=>{
  const h=await moduleHarness(t);h.closeGate=deferred();
  await assert.rejects(h.api.prepareRecordingExport('r1',{storage:h.storage,timeoutMs:15,cleanupTimeoutMs:5}),{name:'TimeoutError'});
  assert.equal(h.calls.includes('url'),false);h.closeGate.resolve();await tick();assert.equal(h.files.size,0);
});

test('导出页清理回执反映仍未结束的原生写入，结束后才报告成功关闭',async t=>{
  const write=deferred();const file=await createFileResource({handle:{createWritable:async()=>({write:()=>write.promise,abort:async()=>{}})},cleanupTimeoutMs:5});
  const pending=file.write(new Blob(['x'])).catch(()=>{});await tick();await file.cleanup();
  t.after(async()=>{write.resolve();await pending;await file.settled;});
  const h=await pageHarness(t);const first=await h.finish();assert.equal(first.ok,false);assert.equal(first.pending,true);
  write.resolve();await pending;await file.settled;assert.deepEqual(await h.finish(),{ok:true});
});
