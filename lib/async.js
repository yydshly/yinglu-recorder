// Bound one operation, not the lifetime of a long recording/copy. Native work
// may finish after cancellation; dispose any resource that arrives too late.
export function bounded(operation, { signal, timeoutMs = 15000,
  message = '操作超时，请重试。', onLate = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = (callback, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || new DOMException('已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(reject, new DOMException(message, 'TimeoutError')), timeoutMs);
    // Invoke only after installing cancellation, and don't start pre-cancelled work.
    let pending;
    try { pending = typeof operation === 'function' ? operation() : operation; }
    catch (error) { finish(reject, error); return; }
    Promise.resolve(pending).then(value => {
      if (done) { Promise.resolve().then(() => onLate(value)).catch(() => {}); return; }
      finish(resolve, value);
    }, error => finish(reject, error));
  });
}
