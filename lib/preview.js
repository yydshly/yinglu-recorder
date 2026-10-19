import { createFileResource } from './file-resource.js';
import { ensureStorageBudget } from './storage-budget.js';
import { bounded } from './async.js';
import { getRecording, recordingBlob, writeRecordingTo } from './db.js';
import { extensionForMime } from './media-format.js';

export const PREVIEW_BLOB_LIMIT = 32 * 1024 * 1024;
const pendingCleanups = new Set();
const lockName = name => `yinglu-preview:${name}`;

// A dead page can leave a staging file. Live previews hold an origin-wide
// lock, so another library page must never remove their backing files.
export async function cleanupPreviewFiles({ storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks, now = Date.now(), olderThanMs = 86400000, signal, timeoutMs = 15000 } = {}) {
  if (!storage?.getDirectory || !locks?.request) return;
  const step = operation => bounded(operation, { signal, timeoutMs, message: '清理预览缓存超时，请重试。' });
  let directory;
  try { const root = await step(() => storage.getDirectory()); directory = await step(() => root.getDirectoryHandle('yinglu-previews')); }
  catch (error) { if (error.name === 'NotFoundError') return; throw error; }
  const iterator = directory.entries()[Symbol.asyncIterator]();
  while (true) {
    const entry = await step(() => iterator.next());
    if (entry.done) break;
    const [name, handle] = entry.value;
    if (!/^preview-\d+-[a-zA-Z0-9-]+\.(webm|mp4)$/.test(name) || handle.kind && handle.kind !== 'file') continue;
    try {
      const file = await step(() => handle.getFile());
      if (!Number.isFinite(file.lastModified) || now - file.lastModified < olderThanMs) continue;
      await step(() => locks.request(lockName(name), { ifAvailable: true }, async lock => {
        if (lock && !signal?.aborted) await step(() => directory.removeEntry(name));
      }));
    } catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }
}

// Small clips keep the cheap existing Blob path. Larger clips are staged to
// disk with bounded IDB reads; the video element seeks in a File-backed URL.
// Never silently fall back to a recording-sized Blob for a large recording.
export async function prepareRecordingPreview(id, { storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks, urls = URL, signal, onProgress, timeoutMs = 15000,
  cleanupTimeoutMs = 1000 } = {}) {
  signal?.throwIfAborted();
  if (pendingCleanups.size) throw new Error('上一段预览仍在结束本机读写，请稍后重试；也可直接保存原视频。');
  const options = { signal, timeoutMs, message: '准备预览超时，请重试；原视频保留。' };
  const step = operation => bounded(operation, options);
  let file, url;
  const cleanup = async () => {
    if (url) { urls.revokeObjectURL(url); url = undefined; }
    await file?.cleanup();
  };
  try {
    const record = await step(() => getRecording(id, options));
    if (!record || !['complete', 'interrupted'].includes(record.status)) throw new Error('录制尚未保存，暂时不能回看。');
    if (record.bytes <= PREVIEW_BLOB_LIMIT) {
      const blob = await step(() => recordingBlob(id, { ...options, onProgress }));
      signal?.throwIfAborted(); url = urls.createObjectURL(blob);
      return { url, storage: 'blob', cleanup };
    }
    if (typeof storage?.getDirectory !== 'function') throw new Error('当前环境不能低内存回看长视频，请先直接保存文件后播放。');
    await cleanupPreviewFiles({ storage, locks, olderThanMs: 0, ...options });
    await ensureStorageBudget(storage, record.bytes, { signal, label: '预览文件' });
    file = await createFileResource({ storage, locks, folder: 'yinglu-previews',
      name: `preview-${Date.now()}-${crypto.randomUUID()}.${extensionForMime(record.mimeType)}`,
      ...options, cleanupTimeoutMs, pendingCleanups });
    await writeRecordingTo(id, file, { ...options, onProgress });
    await file.close();
    const blob = await file.getFile();
    if (blob.size !== record.bytes) throw new Error('临时预览文件大小不完整，请重新载入；原视频保留。');
    signal?.throwIfAborted(); url = urls.createObjectURL(blob);
    return { url, storage: 'opfs', cleanup };
  } catch (error) {
    await cleanup();
    if (['QuotaExceededError', 'NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(error.name))
      throw new Error('无法准备长视频临时文件，请检查本机存储空间，或直接保存原视频后播放。', { cause: error });
    throw error;
  }
}
