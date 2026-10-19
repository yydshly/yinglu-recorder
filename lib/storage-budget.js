import { bounded } from './async.js';
export const MEMORY_VIDEO_LIMIT = 32 * 1024 * 1024;
export function estimateMp4Bytes(record) {
  const pixels = (record.width || 1920) * (record.height || 1080);
  const bitrate = Math.round(Math.max(2000000, Math.min(16000000, pixels * (record.fps || 30) * .13))) + 192000;
  return record.duration > 0 ? Math.ceil(bitrate * record.duration / 8000 * 1.15) : Math.max(record.bytes || 0, MEMORY_VIDEO_LIMIT);
}
// Estimates are advisory: unavailable/denied estimates don't disable recording.
// Actual quota/disk failures still follow the writer's normal failure path.
export async function ensureStorageBudget(storage, bytes, { signal, timeoutMs = 3000, label = '视频临时文件' } = {}) {
  signal?.throwIfAborted();
  if (!storage?.estimate || !(bytes > 0)) return;
  let estimate;
  try { estimate = await bounded(() => storage.estimate(), { signal, timeoutMs }); }
  catch (error) { if (signal?.aborted) throw signal.reason; return; }
  const { usage, quota } = estimate || {};
  if (!Number.isFinite(usage) || !Number.isFinite(quota) || usage < 0 || quota <= 0) return;
  const required = bytes + Math.min(16 * 1024 * 1024, Math.max(1024 * 1024, bytes * .05));
  if (quota - usage < required) throw new Error(`浏览器估算的可用存储空间不足以准备${label}，需要约 ${Math.ceil(required / 1048576)} MB 额外空间。请先清理不用的录制，或直接保存原视频；原视频保留。`);
}
