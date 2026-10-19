import { bounded } from './async.js';

// Small independent stores share the recording database's connection rules.
// Construction is lazy: importing this module never opens a database.
export function createLocalStore({ name, stores, label, timeoutMs = 5000 }) {
  let current;
  function open() {
    if (current) return current;
    const entry = {}; current = entry;
    entry.promise = new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => entry.fail(new Error(`${label}打开超时，请重试。`)), timeoutMs);
      entry.fail = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (current === entry) current = undefined;
        reject(error);
      };
      let req;
      try { req = indexedDB.open(name, 1); } catch (error) { entry.fail(error); return; }
      req.onupgradeneeded = () => {
        if (settled || current !== entry) { req.transaction.abort(); return; }
        for (const store of stores) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store, { keyPath: 'id' });
      };
      req.onerror = () => entry.fail(req.error || new Error(`${label}无法打开，请重试。`));
      req.onsuccess = () => {
        const db = req.result;
        if (settled || current !== entry) { db.close(); return; }
        settled = true; clearTimeout(timer); entry.db = db;
        const invalidate = () => { if (current === entry) current = undefined; };
        db.onclose = invalidate; db.onversionchange = () => { invalidate(); db.close(); };
        resolve(db);
      };
    });
    return entry;
  }
  async function database(options) {
    const entry = open();
    try { return await bounded(() => entry.promise, options); }
    catch (error) { if (error.name === 'TimeoutError' && !entry.db) entry.fail(error); throw error; }
  }
  return async (names, mode, run, options = {}) => {
    options = { timeoutMs, message: `${label}暂未响应，请重试。`, ...options };
    let db = await database(options), tx, failure;
    try { tx = db.transaction(names, mode); }
    catch (error) {
      if (error.name !== 'InvalidStateError') throw error;
      if (current?.db === db) current = undefined;
      db.close(); db = await database(options); tx = db.transaction(names, mode);
    }
    try {
      return await bounded(() => new Promise((resolve, reject) => {
        let result;
        const failed = event => {
          const error = failure || tx.error || event?.target?.error;
          reject(error?.name === 'QuotaExceededError' ? new Error(`本机存储空间不足，请移除部分${label}后重试。`) : error || new Error(`${label}操作被中断，请重试。`));
        };
        tx.onabort = tx.onerror = failed;
        tx.oncomplete = () => { try { resolve(typeof result === 'function' ? result() : result); } catch (error) { reject(error); } };
        const abort = error => { failure = error; try { tx.abort(); } catch { failed(); } };
        try { result = run(tx, abort); } catch (error) { abort(error); }
      }), options);
    } catch (error) { try { tx.abort(); } catch {} throw error; }
  };
}
