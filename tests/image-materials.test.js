import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/image-materials.js', import.meta.url), 'utf8');
const picture = () => ({ name: '参数.png', width: 100, height: 50,
  blob: new Blob(['image'], { type: 'image/png' }), thumbnail: new Blob(['thumb'], { type: 'image/png' }) });

async function harness(t, { failOpen = false } = {}) {
  const stores = { materials: new Map(), images: new Map() }, calls = [], queue = [];
  const h = { stores, calls, opens: 0, failImageWrite: false };
  let running = false;
  const startNext = () => { if (running || !queue.length) return; running = true; queue.shift()(); };
  const db = { close() {}, transaction(names, mode) {
    const tx = {}, log = { names, mode, reads: [] }; calls.push(log);
    let began = false, ended = false, pending = 0, generation = 0, draft;
    const jobs = [];
    const end = () => { running = false; startNext(); };
    tx.abort = () => {
      if (ended) throw new Error('TransactionInactive'); ended = true;
      setImmediate(() => { tx.onabort?.(); end(); });
    };
    const dispatch = job => {
      queueMicrotask(() => {
        if (ended) return;
        try { job(); } catch (error) { tx.error = error; tx.abort(); return; }
        pending--; const current = ++generation;
        setImmediate(() => {
          if (ended || pending || current !== generation) return;
          ended = true;
          if (mode === 'readwrite') for (const name of names) stores[name] = draft[name];
          tx.oncomplete?.(); end();
        });
      });
    };
    const request = action => {
      const req = {}; pending++;
      const job = () => { req.result = action(); req.onsuccess?.(); };
      if (began) dispatch(job); else jobs.push(job);
      return req;
    };
    tx.objectStore = name => ({
      getAll: () => { log.reads.push(name); return request(() => [...draft[name].values()].map(value => structuredClone(value))); },
      get: id => { log.reads.push(name); return request(() => structuredClone(draft[name].get(id))); },
      put: value => request(() => {
        if (name === 'images' && h.failImageWrite) { const error = new Error('disk quota'); error.name = 'QuotaExceededError'; throw error; }
        draft[name].set(value.id, structuredClone(value)); return value.id;
      }),
      delete: id => request(() => draft[name].delete(id))
    });
    queue.push(() => {
      began = true; draft = Object.fromEntries(Object.entries(stores).map(([name, data]) => [name, new Map(data)]));
      for (const job of jobs) dispatch(job);
    });
    queueMicrotask(startNext); return tx;
  } };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open(name) {
    h.opens++; calls.push({ open: name }); const request = {};
    queueMicrotask(() => {
      if (failOpen && h.opens === 1) { request.error = new Error('storage unavailable'); request.onerror(); }
      else { request.result = db; request.onsuccess(); }
    }); return request;
  } } });
  t.after(() => before ? Object.defineProperty(globalThis, 'indexedDB', before) : delete globalThis.indexedDB);
  const code = `import { createLocalStore } from '${new URL('../lib/idb-store.js', import.meta.url).href}';\nconst IMAGE_MAX_BYTES=2097152, IMAGE_MAX_EDGE=1600;\n` + source.replace(/^import .*;\r?\n/gm, '');
  h.api = await import('data:text/javascript;base64,' + Buffer.from(code + '\n//' + Math.random()).toString('base64'));
  return h;
}

test('素材使用独立数据库，列表只读小缩略图元数据，不读取全部原图', async t => {
  const h = await harness(t), saved = await h.api.saveImageMaterial(picture());
  const all = await h.api.listImageMaterials();
  assert.equal(all[0].id, saved.id); assert.equal('blob' in all[0], false); assert.equal(all[0].thumbnail.size, 5);
  assert.equal((await h.api.getImageMaterial(saved.id)).size, 5);
  assert.equal(h.calls.find(call => call.open).open, 'yinglu-image-materials');
  assert.deepEqual(h.calls.filter(call => call.names)[1], { names: ['materials'], mode: 'readonly', reads: ['materials'] });
});

test('多个导入竞争最后名额时，数量检查和图片写入处于同一读写事务', async t => {
  const h = await harness(t);
  for (let i = 0; i < 11; i++) h.stores.materials.set(`old-${i}`, { id: `old-${i}`, createdAt: i, bytes: 1 });
  const results = await Promise.allSettled([h.api.saveImageMaterial(picture()), h.api.saveImageMaterial(picture())]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(results.find(value => value.status === 'rejected').reason.message, /最多准备 12/);
  assert.equal(h.stores.materials.size, 12); assert.equal(h.stores.images.size, 1);
});

test('合计存储上限检查拒绝超额素材，不占用图片存储', async t => {
  const h = await harness(t); h.stores.materials.set('old', { id: 'old', bytes: 16 * 1024 * 1024 - 5 });
  await assert.rejects(h.api.saveImageMaterial(picture()), /合计最多 16 MB/);
  assert.equal(h.stores.materials.size, 1); assert.equal(h.stores.images.size, 0);
});

test('图片写入失败回滚同一事务中的元数据，恢复后可重试；删除同时释放两类记录', async t => {
  const h = await harness(t); h.failImageWrite = true;
  await assert.rejects(h.api.saveImageMaterial(picture()), /存储空间不足/);
  assert.equal(h.stores.materials.size, 0); assert.equal(h.stores.images.size, 0);
  h.failImageWrite = false; const saved = await h.api.saveImageMaterial(picture());
  await h.api.deleteImageMaterial(saved.id);
  assert.equal((await h.api.listImageMaterials()).length, 0); assert.equal(await h.api.getImageMaterial(saved.id), undefined);
});

test('打开素材库失败不污染后续打开，非法图片或过大缩略图在写入前拒绝', async t => {
  const h = await harness(t, { failOpen: true });
  await assert.rejects(h.api.listImageMaterials(), /storage unavailable/);
  assert.deepEqual(await h.api.listImageMaterials(), []); assert.equal(h.opens, 2);
  for (const invalid of [{ width: 0 }, { height: 1601 }, { blob: new Blob(['svg'], { type: 'image/svg+xml' }) }, { thumbnail: new Blob([new Uint8Array(131073)], { type: 'image/png' }) }])
    await assert.rejects(h.api.saveImageMaterial({ ...picture(), ...invalid }), /图片素材无效/);
  assert.equal(h.stores.materials.size, 0);
});
