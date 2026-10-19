import { bounded } from './async.js';

const unfinishedCleanups = new Set();
export const pendingFileCleanupCount = () => unfinishedCleanups.size;
export const temporaryLockName = (folder, name) => `${folder === 'yinglu-previews' ? 'yinglu-preview' : 'yinglu-export'}:${name}`;

// Own every native mutation until it actually settles. UI cancellation can
// return early, but cannot release the file lock ahead of a late create/commit.
export async function createFileResource({ storage, folder, name, handle: suppliedHandle,
  locks = globalThis.navigator?.locks, signal, timeoutMs = 15000, cleanupTimeoutMs = 1000,
  pendingCleanups, message = '本机文件操作超时，请重试；原视频保留。' } = {}) {
  signal?.throwIfAborted();
  if (pendingCleanups?.size) throw new Error('上一项本机文件操作仍在结束，请稍后重试；原视频保留。');
  const controller = new AbortController(), pending = new Set();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const step = operation => bounded(operation, { signal: controller.signal, timeoutMs, message });
  let directory, writer, handle, lockTask, unlock, disposed = false, finalizing = false, started = false, done;
  const settled = new Promise(resolve => { done = resolve; });
  settled.then(() => { pendingCleanups?.delete(settled); unfinishedCleanups.delete(settled); });
  const finalize = () => {
    if (!disposed || pending.size || finalizing) return;
    finalizing = true;
    (async () => {
      try {
        if (writer) { try { await writer.abort(); } catch {} writer = undefined; }
        if (directory && name) { try { await directory.removeEntry(name); } catch {} }
      } finally { unlock?.(); await lockTask; done(); }
    })().catch(() => done());
  };
  const mutate = (operation, receive = () => {}) => step(() => {
    const task = Promise.resolve().then(operation); pending.add(task);
    task.then(receive, () => {}).finally(() => { pending.delete(task); finalize(); });
    return task;
  });
  const cleanup = async () => {
    if (!started) { started = true; pendingCleanups?.add(settled); unfinishedCleanups.add(settled); }
    disposed = true; controller.abort(); signal?.removeEventListener('abort', abort);
    if (writer && pending.size) {
      const current = writer; writer = undefined;
      const task = Promise.resolve().then(() => current.abort()); pending.add(task);
      task.catch(() => {}).finally(() => { pending.delete(task); finalize(); });
    }
    finalize();
    await bounded(() => settled, { timeoutMs: cleanupTimeoutMs }).catch(() => {});
  };
  try {
    handle = suppliedHandle;
    if (!handle) {
      const root = await step(() => storage.getDirectory());
      directory = await step(() => root.getDirectoryHandle(folder, { create: true }));
      if (locks?.request) {
        let acquired, failed;
        const ready = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
        const held = new Promise(resolve => { unlock = resolve; });
        lockTask = locks.request(temporaryLockName(folder, name), { signal: controller.signal }, async () => {
          acquired(); if (disposed) unlock(); await held;
        }).catch(error => { failed(error); });
        await step(() => ready);
      }
      handle = await mutate(() => directory.getFileHandle(name, { create: true }));
    }
    if (typeof handle.createWritable !== 'function') throw new DOMException('当前环境不支持异步文件写入', 'NotSupportedError');
    writer = await mutate(() => handle.createWritable(), value => { writer = value; });
    return { name, cleanup, settled,
      write: chunk => { const current = writer; return mutate(() => current.write(chunk)); },
      close: () => { const current = writer; return mutate(() => current.close(), () => { writer = undefined; }); },
      getFile: () => step(() => handle.getFile()) };
  } catch (error) { await cleanup(); throw error; }
}
