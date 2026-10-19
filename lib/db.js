import { bounded } from './async.js';
let connection;
function openDatabase() {
  if (connection) return connection;
  const entry = {}; connection = entry;
  entry.promise = new Promise((resolve, reject) => {
    let settled = false, blocked = false;
    const timer = setTimeout(() => entry.fail(new DOMException(blocked ? '本地数据库升级仍在等待其他页面关闭，请关闭旧录制库后重试。' : '连接本地数据库超时，请重试；已保存片段保留。', 'TimeoutError')), 15000);
    entry.fail = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (connection === entry) connection = undefined;
      reject(error);
    };
    let req;
    try { req = indexedDB.open('yinglu-recordings', 2); }
    catch (error) { entry.fail(error); return; }
    req.onblocked = () => { blocked = true; };
    req.onupgradeneeded = () => {
      if (settled || connection !== entry) { req.transaction.abort(); return; }
      const db = req.result;
      const records = db.objectStoreNames.contains('recordings') ? req.transaction.objectStore('recordings') : db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'index'] });
      if (!records.indexNames.contains('createdAtId')) records.createIndex('createdAtId', ['createdAt', 'id']);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled || connection !== entry) { db.close(); return; }
      settled = true; clearTimeout(timer); entry.db = db;
      const invalidate = () => { if (connection === entry) connection = undefined; };
      db.onversionchange = () => { invalidate(); db.close(); };
      db.onclose = invalidate;
      resolve(db);
    };
    req.onerror = () => entry.fail(req.error || new Error('无法打开本地数据库，请重试。'));
  });
  return entry;
}
async function database(options) {
  const entry = openDatabase();
  try { return await bounded(() => entry.promise, options); }
  catch (error) {
    // A caller's cancellation does not cancel other readers. A timed-out open
    // is retired; a late success can only close its own connection.
    if (error.name === 'TimeoutError' && !entry.db) entry.fail(error);
    throw error;
  }
}
async function transaction(stores, mode, run, options) {
  let db = await database(options);
  // Retry only transaction creation on a known closed connection. Never replay
  // an aborted/failed write, whose commit outcome might be ambiguous.
  let tx;
  try { tx = db.transaction(stores, mode); }
  catch (error) {
    if (error.name !== 'InvalidStateError') throw error;
    if (connection?.db === db) connection = undefined;
    db.close(); db = await database(options); tx = db.transaction(stores, mode);
  }
  try { return await bounded(() => new Promise((resolve, reject) => {
    let result;
    tx.oncomplete = () => { try { resolve(typeof result === 'function' ? result() : result); } catch (error) { reject(error); } };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('本地存储写入被中断'));
    try { result = run(tx); } catch (error) { try { tx.abort(); } catch {} reject(error); }
  }), options); } catch (error) {
    try { tx?.abort(); } catch {}
    throw error;
  }
}
export const saveRecording = (recording) => transaction(['recordings'], 'readwrite', tx => {
  tx.objectStore('recordings').put(recording);
});
export const saveChunk = (id, index, blob, recording) => transaction(recording ? ['chunks', 'recordings'] : ['chunks'], 'readwrite', tx => {
  tx.objectStore('chunks').put({ id, index, blob });
  if (recording) tx.objectStore('recordings').put(recording);
});
export const getRecording = (id, options) => transaction(['recordings'], 'readonly', tx => {
  const req = tx.objectStore('recordings').get(id); return () => req.result;
}, options);
export const patchRecording = (id, patch) => transaction(['recordings'], 'readwrite', tx => {
  let updated;
  const store = tx.objectStore('recordings'), req = store.get(id);
  req.onsuccess = () => {
    if (!req.result) return;
    updated = { ...req.result, ...patch }; store.put(updated);
  };
  return () => updated;
});
export function listRecordingPage({ limit = 20, before, signal, timeoutMs = 15000 } = {}) {
  limit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  return transaction(['recordings'], 'readonly', tx => {
    const records = [];
    const range = before ? IDBKeyRange.upperBound(before, true) : null;
    const req = tx.objectStore('recordings').index('createdAtId').openCursor(range, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const r = cursor.value;
      // Lists do not retain detailed performance samples or recording options.
      records.push({ id: r.id, createdAt: r.createdAt, title: r.title, duration: r.duration,
        bytes: r.bytes, mimeType: r.mimeType, status: r.status, export: r.export });
      if (records.length <= limit) cursor.continue();
    };
    return () => {
      const hasMore = records.length > limit;
      if (hasMore) records.pop();
      const last = records.at(-1);
      return { records, hasMore, next: hasMore && last ? [last.createdAt, last.id] : null };
    };
  }, { signal, timeoutMs, message: '读取录制列表超时，请重试；视频保留。' });
}
export async function* recordingChunks(id, { batchSize = 8, signal, timeoutMs = 15000 } = {}) {
  batchSize = Math.max(1, Math.min(64, Math.floor(batchSize) || 8));
  let previous = -1;
  while (true) {
    signal?.throwIfAborted();
    const page = await transaction(['chunks'], 'readonly', tx => {
      const chunks = [];
      const range = IDBKeyRange.bound([id, previous + 1], [id, Number.MAX_SAFE_INTEGER]);
      const req = tx.objectStore('chunks').openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        chunks.push(cursor.value);
        if (chunks.length < batchSize) cursor.continue();
      };
      return () => chunks;
    }, { signal, timeoutMs, message: '读取视频片段超时，请重试；原视频保留。' });
    if (!page.length) break;
    for (const chunk of page) {
      signal?.throwIfAborted();
      if (chunk.index !== previous + 1) throw new Error('视频片段缺失，导出已取消；请保留原始录制检查恢复情况');
      previous = chunk.index;
      yield chunk.blob;
    }
    if (page.length < batchSize) break;
  }
}
export async function writeRecordingTo(id, writable, { onProgress = () => {}, signal, timeoutMs = 15000 } = {}) {
  const record = await getRecording(id, { signal, timeoutMs });
  if (!record) throw new Error('没有找到录制文件');
  let bytes = 0, count = 0;
  // Each page is released before reading the next one. File export does not
  // gather a full recording or construct a recording-sized Blob.
  for await (const chunk of recordingChunks(id, { signal, timeoutMs })) {
    await bounded(() => writable.write(chunk), { signal, timeoutMs, message: '写入视频片段超时，请检查存储后重试；原视频保留。' });
    bytes += chunk.size; count++;
    await bounded(() => onProgress(bytes, record.bytes), { signal, timeoutMs, message: '保存进度暂未响应，请重试；原视频保留。' });
  }
  if (!count) throw new Error('没有可恢复的视频片段');
  if (bytes !== record.bytes) throw new Error('视频片段大小与保存记录不一致，导出未完成；请保留原始录制');
  const latest = await getRecording(id, { signal, timeoutMs });
  if (!latest || latest.bytes !== record.bytes || latest.mimeType !== record.mimeType) throw new Error('导出期间源视频发生变化，导出未完成');
  return bytes;
}
export async function recordingBlob(id, { onProgress, signal, timeoutMs = 15000 } = {}) {
  const record = await getRecording(id, { signal, timeoutMs });
  if (!record) throw new Error('没有找到录制文件');
  const chunks = [];
  await writeRecordingTo(id, { write: chunk => { chunks.push(chunk); } }, { onProgress, signal, timeoutMs });
  return new Blob(chunks, { type: record.mimeType });
}
export const deleteRecording = id => transaction(['recordings', 'chunks'], 'readwrite', tx => {
  tx.objectStore('recordings').delete(id);
  tx.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
});
