import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../lib/db.js', import.meta.url), 'utf8')).replace(/^import \{ bounded \}.*;\r?\n/m, `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n`);

async function harness(t, { failFirstOpen = false, count = 19 } = {}) {
  const chunks = Array.from({ length: count }, (_, index) => ({ id: 'r1', index, blob: new Blob([`${index},`]) }));
  const record = { id: 'r1', mimeType: 'video/webm', bytes: chunks.reduce((sum, chunk) => sum + chunk.blob.size, 0) };
  const h = { opens: 0, cursorReads: 0, getAllChunks: 0, record, chunks, transactions: [] };
  const db = { transaction(stores, mode) {
    const log = { stores, mode, reads: 0, writes: 0 }; h.transactions.push(log);
    const tx = { abort() { h.aborts = (h.aborts || 0) + 1; this.onabort?.(); } }; let pending = 0, generation = 0;
    const request = execute => {
      const req = {}; pending++;
      queueMicrotask(() => {
        if (h.stall) return;
        try { execute(req); req.onsuccess?.(); } catch (error) { tx.error = error; tx.onerror?.(); }
        pending--; const current = ++generation;
        setImmediate(() => { if (!pending && generation === current) tx.oncomplete?.(); });
      });
      return req;
    };
    tx.objectStore = name => ({
      get: id => { log.reads++; return request(req => { req.result = id === h.record.id ? structuredClone(h.record) : undefined; }); },
      put: value => { log.writes++; return request(req => { if (name === 'recordings') h.record = structuredClone(value); req.result = value.id; }); },
      getAll: () => { if (name === 'chunks') { h.getAllChunks++; throw new Error('Unbounded read'); } return request(req => { req.result = [record]; }); },
      openCursor(range) {
        h.cursorReads++;
        const page = chunks.filter(chunk => chunk.index >= range.lower[1] && chunk.index <= range.upper[1]);
        const req = {}; let index = 0;
        const advance = () => {
          pending++;
          queueMicrotask(() => {
            const value = page[index++]; req.result = value ? { value, continue: advance } : null;
            req.onsuccess?.(); pending--; const current = ++generation;
            setImmediate(() => { if (!pending && generation === current) tx.oncomplete?.(); });
          });
        };
        advance(); return req;
      }
    });
    return tx;
  } };
  const values = {
    indexedDB: { open() { h.opens++; const req = {}; queueMicrotask(() => { if (failFirstOpen && h.opens === 1) { req.error = new Error('temporarily unavailable'); req.onerror(); } else { req.result = db; req.onsuccess(); } }); return req; } },
    IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) }
  };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  h.api = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
  return h;
}

test('存储首次初始化失败后下一次操作可以重新打开', async t => {
  const h = await harness(t, { failFirstOpen: true });
  await assert.rejects(h.api.getRecording('r1'), /temporarily unavailable/);
  assert.equal((await h.api.getRecording('r1')).id, 'r1'); assert.equal(h.opens, 2);
});

test('文件导出按片段顺序分批读取，不使用全量 getAll', async t => {
  const h = await harness(t), written = [], progress = [];
  const bytes = await h.api.writeRecordingTo('r1', { write: async blob => written.push(await blob.text()) }, { onProgress: value => progress.push(value) });
  assert.equal(written.join(''), Array.from({ length: 19 }, (_, index) => `${index},`).join(''));
  assert.equal(bytes, h.record.bytes); assert.equal(progress.at(-1), bytes);
  assert.equal(h.getAllChunks, 0); assert.equal(h.cursorReads, 3);
});

test('导出尊重文件写入背压，写入失败后不继续读取下一批', async t => {
  const h = await harness(t); let writes = 0;
  await assert.rejects(h.api.writeRecordingTo('r1', { write: async () => { writes++; throw new Error('disk full'); } }), /disk full/);
  assert.equal(writes, 1); assert.equal(h.cursorReads, 1);
});

test('Blob 回退保留片段顺序与类型', async t => {
  const h = await harness(t, { count: 3 });
  const blob = await h.api.recordingBlob('r1'); assert.equal(blob.type, 'video/webm'); assert.equal(await blob.text(), '0,1,2,');
});

test('没有已保存片段时导出明确报错', async t => {
  const h = await harness(t, { count: 0 });
  await assert.rejects(h.api.recordingBlob('r1'), /没有可恢复的视频片段/);
});

test('取消分段读取会停止后续文件写入', async t => {
  const h = await harness(t), controller = new AbortController(); let writes = 0;
  await assert.rejects(h.api.writeRecordingTo('r1', { write: async () => { writes++; controller.abort(); } }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(writes, 1); assert.equal(h.cursorReads, 1);
});

test('元数据补丁在同一个读写事务中合并，保留已保存的视频字段', async t => {
  const h = await harness(t); h.record.status = 'complete'; h.record.title = '原始视频';
  const updated = await h.api.patchRecording('r1', { export: { status: 'queued' } });
  assert.equal(updated.title, '原始视频'); assert.equal(updated.bytes, h.record.bytes); assert.equal(updated.status, 'complete');
  assert.deepEqual(updated.export, { status: 'queued' });
  assert.equal(h.transactions.length, 1);
  assert.deepEqual(h.transactions[0], { stores: ['recordings'], mode: 'readwrite', reads: 1, writes: 1 });
  assert.deepEqual((await h.api.getRecording('r1')).export, { status: 'queued' });
});

test('不存在的录制应用补丁不会重新创建空记录', async t => {
  const h = await harness(t);
  assert.equal(await h.api.patchRecording('missing', { export: { status: 'queued' } }), undefined);
  assert.equal(h.transactions[0].writes, 0); assert.equal(await h.api.getRecording('missing'), undefined);
});

test('分批读取期间后续片段消失，不把不完整文件当作成功', async t => {
  const h = await harness(t); let writes = 0;
  await assert.rejects(h.api.writeRecordingTo('r1', { write: async () => { if (++writes === 8) h.chunks.length = 0; } }), /大小.*不一致/);
  assert.equal(writes, 8);
});

test('中间片段缺号时导出失败，不能只比较是否有数据', async t => {
  const h = await harness(t); h.chunks.splice(4, 1);
  await assert.rejects(h.api.writeRecordingTo('r1', { write: async () => {} }), /片段缺失/);
});

test('导出期间源记录改变，禁止报告成功', async t => {
  const h = await harness(t); let changed = false;
  await assert.rejects(h.api.writeRecordingTo('r1', { write: async () => { if (!changed) { changed = true; h.record.bytes++; } } }), /源视频发生变化/);
});

test('等待中的只读事务可以取消并主动abort，不等磁盘回调', async t => {
  const h = await harness(t), controller = new AbortController();
  h.stall = true;
  const reading = h.api.getRecording('r1',{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve)); controller.abort();
  await assert.rejects(reading,{name:'AbortError'}); assert.equal(h.aborts,1);
});
test('只读事务和文件写入分别有空闲超时，不再永远等待', async t => {
  const h = await harness(t); h.stall = true;
  await assert.rejects(h.api.getRecording('r1',{timeoutMs:15}),{name:'TimeoutError'}); assert.equal(h.aborts,1);
  h.stall = false;
  await assert.rejects(h.api.writeRecordingTo('r1',{write:()=>new Promise(()=>{})},{timeoutMs:15}),{name:'TimeoutError'});
  assert.equal(h.cursorReads,1);
});
