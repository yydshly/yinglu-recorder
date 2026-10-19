import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../lib/db.js', import.meta.url), 'utf8')).replace("'./async.js'", JSON.stringify(new URL('../lib/async.js', import.meta.url).href));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(t) {
  const h = { requests: [], databases: [], rows: [], reads: 0 };
  const values = {
    indexedDB: { open(name, version) { const req = { name, version }; h.requests.push(req); return req; } },
    IDBKeyRange: { upperBound: (upper, open) => ({ upper, open }) }
  };
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  h.db = () => {
    const db = { closes: 0, writes: 0, transactions: 0, close() { this.closes++; }, transaction(stores, mode) {
      db.transactions++;
      if (db.closed) throw new DOMException('closed', 'InvalidStateError');
      const tx = { abort() { this.onabort?.(); } };
      const complete = () => setImmediate(() => { if (db.abortWrite && mode === 'readwrite') tx.onabort?.(); else tx.oncomplete?.(); });
      tx.objectStore = () => ({
        get() { const req = {}; queueMicrotask(() => { req.result = { id: 'r1' }; req.onsuccess?.(); complete(); }); return req; },
        put() { db.writes++; queueMicrotask(complete); },
        getAll() { throw new Error('unbounded read'); },
        index(name) {
          assert.equal(name, 'createdAtId');
          return { openCursor(range, direction) {
            assert.equal(direction, 'prev');
            const req = {}; let i = 0;
            const rows = h.rows.filter(r => !range || r.createdAt < range.upper[0] || r.createdAt === range.upper[0] && r.id < range.upper[1]);
            const advance = () => queueMicrotask(() => {
              const value = rows[i++]; if (value) h.reads++;
              let continued = false;
              req.result = value ? { value, continue() { continued = true; advance(); } } : null;
              req.onsuccess?.(); if (!continued) complete();
            }); advance(); return req;
          } };
        }
      }); return tx;
    } };
    h.databases.push(db); return db;
  };
  h.success = (i, db = h.db()) => { const req = h.requests[i]; req.result = db; req.onsuccess(); return db; };
  h.api = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
  t.after(() => h.databases.forEach(db => db.onclose?.()));
  return h;
}

test('数据库打开挂起超时后可重连，迟到成功只关闭旧连接', async t => {
  const h = await harness(t);
  await assert.rejects(h.api.getRecording('r1', { timeoutMs: 8 }), { name: 'TimeoutError' });
  const reading = h.api.getRecording('r1'); const current = h.success(1);
  assert.equal((await reading).id, 'r1');
  const late = h.success(0); assert.equal(late.closes, 1); assert.equal(current.closes, 0);
  h.requests[0].error = new Error('late'); h.requests[0].onerror();
  await h.api.getRecording('r1'); assert.equal(h.requests.length, 2);
});

test('旧数据库的关闭通知不清除新连接', async t => {
  const h = await harness(t); const first = h.api.getRecording('r1'); const old = h.success(0); await first;
  old.onversionchange(); assert.equal(old.closes, 1);
  const second = h.api.getRecording('r1'); h.success(1); await second;
  old.onclose(); await h.api.getRecording('r1'); assert.equal(h.requests.length, 2);
});

test('取消一个等待者不会取消共用数据库连接', async t => {
  const h = await harness(t), controller = new AbortController();
  const canceled = h.api.getRecording('r1', { signal: controller.signal });
  const reading = h.api.getRecording('r1'); controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' }); h.success(0);
  assert.equal((await reading).id, 'r1'); assert.equal(h.requests.length, 1);
});

test('事务创建时发现连接关闭才重连，已启动的失败写入绝不重放', async t => {
  const h = await harness(t); const reading = h.api.getRecording('r1'); const old = h.success(0); await reading;
  old.closed = true;
  const write = h.api.saveRecording({ id: 'r2' }); await tick();
  const current = h.success(1); await write; assert.equal(old.writes, 0); assert.equal(current.writes, 1);
  current.abortWrite = true;
  await assert.rejects(h.api.saveRecording({ id: 'r3' }), /中断/);
  assert.equal(current.writes, 2); assert.equal(h.requests.length, 2);
});

test('超时打开请求迟到升级会被中止，不占用新一代连接', async t => {
  const h = await harness(t);
  await assert.rejects(h.api.getRecording('r1', { timeoutMs: 8 }), { name: 'TimeoutError' });
  let aborts = 0; h.requests[0].transaction = { abort() { aborts++; } };
  h.requests[0].onupgradeneeded(); assert.equal(aborts, 1);
  const retry = h.api.getRecording('r1'); h.success(1); await retry;
});

test('复合索引分页只读一页加一个探测项，同时间记录不会漏项或重复', async t => {
  const h = await harness(t);
  h.rows = Array.from({ length: 105 }, (_, i) => ({ id: String(200 - i).padStart(3, '0'), createdAt: i < 35 ? 100 : 99, title: `视频${i}`, pageDiagnostics: { huge: true } }));
  const first = h.api.listRecordingPage(); h.success(0);
  let page = await first, records = [...page.records]; assert.equal(h.reads, 21);
  assert.equal(page.records.length, 20); assert.equal(page.records[0].pageDiagnostics, undefined);
  const before = page.next;
  h.rows.unshift({ id: 'new', createdAt: 101 });
  h.rows = h.rows.filter(r => r.id !== '199');
  page = await h.api.listRecordingPage({ before }); records.push(...page.records);
  while (page.hasMore) { page = await h.api.listRecordingPage({ before: page.next }); records.push(...page.records); }
  assert.equal(records.length, 105); assert.equal(new Set(records.map(r => r.id)).size, 105);
  assert.equal(records.some(r => r.id === 'new'), false); assert.equal(page.next, null);
});

test('侧栏最近三条仅读取四条，页大小有硬上限', async t => {
  const h = await harness(t); h.rows = Array.from({ length: 500 }, (_, i) => ({ id: String(999 - i), createdAt: 1 }));
  const reading = h.api.listRecordingPage({ limit: 3 }); h.success(0); await reading; assert.equal(h.reads, 4);
  h.reads = 0; assert.equal((await h.api.listRecordingPage({ limit: 100000 })).records.length, 100); assert.equal(h.reads, 101);
});
