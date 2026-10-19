export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function normalizeRect(a, b, width, height) {
  const x = clamp(Math.min(a.x, b.x), 0, width);
  const y = clamp(Math.min(a.y, b.y), 0, height);
  return { x: x / width, y: y / height,
    width: (clamp(Math.max(a.x, b.x), 0, width) - x) / width,
    height: (clamp(Math.max(a.y, b.y), 0, height) - y) / height };
}
export function cropPixels(crop, width, height) {
  const c = crop || { x: 0, y: 0, width: 1, height: 1 };
  const x = clamp(Math.round(c.x * width), 0, width - 1);
  const y = clamp(Math.round(c.y * height), 0, height - 1);
  return { x, y, width: clamp(Math.round(c.width * width), 1, width - x),
    height: clamp(Math.round(c.height * height), 1, height - y) };
}
export function outputSize(width, height, quality = '1080') {
  const max = quality === 'original' ? Infinity : ['720', 'performance'].includes(quality) ? 1280 : 1920;
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(2, Math.floor(width * scale / 2) * 2),
    height: Math.max(2, Math.floor(height * scale / 2) * 2) };
}
export function elapsed(state, now = Date.now()) {
  if (!state.startedAt) return 0;
  return Math.max(0, (state.pausedAt || now) - state.startedAt - (state.pausedMs || 0));
}
export function clockText(ms) {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}
export function fileSize(bytes = 0) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}
