import { bounded } from './async.js';
import { createFileResource, temporaryLockName } from './file-resource.js';
import { MEMORY_VIDEO_LIMIT, ensureStorageBudget, estimateMp4Bytes } from './storage-budget.js';
import { getRecording, recordingBlob, writeRecordingTo } from './db.js';
import { extensionForMime, mediaFormat } from './media-format.js';

export function recordingFilename(recording, mimeType = recording.mimeType) {
  const created = new Date(recording.createdAt);
  const timestamp = Number.isNaN(created.getTime()) ? '未注明时间' : created.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-');
  const title = Array.from(String(recording.title || '屏幕演示')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '-')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '')).slice(0, 60).join('') || '屏幕演示';
  return `映录-${timestamp}-${title}.${extensionForMime(mimeType)}`;
}

const unsupported = error => ['NotSupportedError', 'SecurityError', 'NotAllowedError'].includes(error?.name);
const pendingCleanups = new Set();

export async function prepareRecordingExport(recordingId, {
  storage = globalThis.navigator?.storage, locks = globalThis.navigator?.locks, urls = URL, signal,
  onProgress = () => {}, format = 'original', token = crypto.randomUUID(), convertToMp4,
  timeoutMs = 15000, cleanupTimeoutMs = 1000
} = {}) {
  signal?.throwIfAborted();
  if (pendingCleanups.size) throw new Error('上一项导出仍在结束本机读写，请稍后重试；原视频保留。');
  const options = { signal, timeoutMs, message: '准备导出超时，请重试；原视频保留。' };
  const step = operation => bounded(operation, options);
  const record = await step(() => getRecording(recordingId, options));
  if (!record) throw new Error('没有找到需要保存的录制');
  if (!['complete', 'interrupted'].includes(record.status)) throw new Error('录制尚未结束，暂时不能保存');
  if (!['original', 'mp4'].includes(format)) throw new Error('不支持的导出格式');
  const shared = { storage, locks, urls, signal, onProgress, timeoutMs, cleanupTimeoutMs };
  if (format === 'mp4' && mediaFormat(record.mimeType) !== 'mp4') {
    let source, converted;
    try {
      if (storage?.getDirectory) await ensureStorageBudget(storage, (record.bytes || 0) + estimateMp4Bytes(record), { signal, label: '转换来源与 MP4 临时文件' });
      source = await prepareRecordingExport(recordingId, { ...shared, token: `${token}-source` });
      const convert = convertToMp4 || (await import('./mp4.js')).convertToMp4;
      converted = await convert(source.url, record, { ...shared, token });
      let cleanupPromise;
      return { ...converted, filename: recordingFilename(record, 'video/mp4'), format: 'mp4',
        cleanup: () => cleanupPromise ||= (async () => { try { await converted.cleanup(); } finally { await source.cleanup(); } })() };
    } catch (error) { await converted?.cleanup().catch(() => {}); await source?.cleanup().catch(() => {}); throw error; }
  }
  let file, objectUrl;
  const cleanup = async () => {
    if (objectUrl) { urls.revokeObjectURL(objectUrl); objectUrl = undefined; }
    await file?.cleanup();
  };
  try {
    if (typeof storage?.getDirectory === 'function') {
      await ensureStorageBudget(storage, record.bytes, { signal, label: '导出临时文件' });
      const owner = String(token).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 100) || crypto.randomUUID();
      const temporaryName = `auto-${Date.now()}-${owner}.${extensionForMime(record.mimeType)}`;
      try {
        file = await createFileResource({ storage, locks, folder: 'yinglu-exports', name: temporaryName,
          ...options, cleanupTimeoutMs, pendingCleanups });
      } catch (error) { if (!unsupported(error)) throw error; }
      if (file) {
        await step(() => onProgress(0, record.bytes, { phase: 'preparing', temporaryName, storage: 'opfs' }));
        const bytes = await writeRecordingTo(recordingId, file, { signal, timeoutMs,
          onProgress: (bytes, total) => onProgress(bytes, total, { phase: 'preparing', temporaryName, storage: 'opfs' }) });
        await step(() => onProgress(bytes, record.bytes, { phase: 'committing', temporaryName, storage: 'opfs' }));
        await file.close(); const blob = await file.getFile();
        if (blob.size !== bytes) throw new Error('导出临时文件大小不完整，请重新保存；原视频保留。');
        signal?.throwIfAborted(); objectUrl = urls.createObjectURL(blob);
        return { url: objectUrl, filename: recordingFilename(record), format: mediaFormat(record.mimeType), storage: 'opfs', cleanup };
      }
    }
    if (!(record.bytes >= 0) || record.bytes > MEMORY_VIDEO_LIMIT)
      throw new Error('当前环境不能低内存导出这段大视频，请使用「直接保存文件」；原视频保留。');
    const blob = await step(() => recordingBlob(recordingId, { signal, timeoutMs,
      onProgress: (bytes, total) => onProgress(bytes, total, { phase: 'preparing', storage: 'blob' }) }));
    signal?.throwIfAborted(); objectUrl = urls.createObjectURL(blob);
    return { url: objectUrl, filename: recordingFilename(record), format: mediaFormat(record.mimeType), storage: 'blob', cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function cleanupExportTemporaryFiles({ storage = globalThis.navigator?.storage, activeTokens = [], finishedTokens = [], olderThanMs = 86400000, now = Date.now(), locks = globalThis.navigator?.locks, signal, timeoutMs = 15000 } = {}) {
  const result = { removed: [], errors: [] };
  if (typeof storage?.getDirectory !== 'function') return result;
  const step = operation => bounded(operation, { signal, timeoutMs });
  let directory;
  try { const root = await step(() => storage.getDirectory()); directory = await step(() => root.getDirectoryHandle('yinglu-exports')); }
  catch (error) { if (error.name !== 'NotFoundError') result.errors.push(error.message); return result; }
  const belongs = (name, token) => name.includes(`-${token}.`) || name.includes(`-${token}-source.`);
  try {
    const iterator = directory.entries()[Symbol.asyncIterator]();
    while (true) {
      const entry = await step(() => iterator.next()); if (entry.done) break;
      const [name, handle] = entry.value;
      if (handle.kind && handle.kind !== 'file' || !/^(?:auto-(?:\d+-)?[a-zA-Z0-9-]+|convert-[a-zA-Z0-9-]+)\.(?:webm|mp4)$/.test(name)) continue;
      if (activeTokens.some(token => token && belongs(name, token))) continue;
      let knownFinished = finishedTokens.some(token => token && belongs(name, token));
      try {
        const file = await step(() => handle.getFile());
        if (!knownFinished && (!Number.isFinite(file.lastModified) || now - file.lastModified < olderThanMs)) continue;
        const remove = async () => { await step(() => directory.removeEntry(name)); result.removed.push(name); };
        if (locks?.request) await step(() => locks.request(temporaryLockName('yinglu-exports', name), { ifAvailable: true }, lock => lock ? remove() : undefined));
        else await remove();
      } catch (error) {
        if (signal?.aborted || error.name === 'TimeoutError') throw error;
        if (error.name !== 'NotFoundError') result.errors.push(`${name}: ${error.message}`);
      }
    }
  } catch (error) { result.errors.push(error.message); }
  return result;
}
