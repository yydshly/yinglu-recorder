import { createLocalStore } from './idb-store.js';
export const MUSIC_LIMIT = 12;
export const MUSIC_FILE_LIMIT = 32 * 1024 * 1024;
export const MUSIC_BYTE_LIMIT = 128 * 1024 * 1024;
const mimeByExtension = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm' };
export function musicFileBlob(file) {
  const type = mimeByExtension[String(file?.name || '').split('.').pop().toLowerCase()];
  if (!(file instanceof Blob) || !type || !file.size || file.size > MUSIC_FILE_LIMIT) throw new Error('请选择 MP3、WAV、OGG、M4A、AAC、FLAC 或 WebM 音乐，单首不超过 32 MB。');
  return new Blob([file], { type });
}
export function musicConfig(value) {
  if (!value?.id) return null;
  if (typeof value.id !== 'string' || value.id.length > 100 || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1 || typeof value.loop !== 'boolean') throw new Error('音乐设置无效，请重新选择音乐。');
  return { id: value.id, volume: value.volume, loop: value.loop };
}
const transaction = createLocalStore({ name: 'yinglu-music', stores: ['tracks', 'files', 'settings'], label: '音乐库' });
export const listMusic = () => transaction(['tracks'], 'readonly', tx => {
  const request = tx.objectStore('tracks').getAll(); return () => request.result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
});
export const getMusicFile = id => transaction(['files'], 'readonly', tx => {
  const request = tx.objectStore('files').get(id); return () => request.result?.blob;
});
export function saveMusic({ name, blob, duration }) {
  if (!(blob instanceof Blob) || !blob.type.startsWith('audio/') || !blob.size || blob.size > MUSIC_FILE_LIMIT || !Number.isFinite(duration) || duration <= 0 || duration > 3600)
    return Promise.reject(new Error('音乐无效，请选择时长不超过 60 分钟、单首不超过 32 MB 的本地音乐。'));
  const record = { id: crypto.randomUUID(), name: String(name || '音乐').slice(0, 100), bytes: blob.size, duration, type: blob.type, createdAt: Date.now() };
  return transaction(['tracks', 'files'], 'readwrite', (tx, abort) => {
    const store = tx.objectStore('tracks'), request = store.getAll();
    request.onsuccess = () => {
      if (request.result.length >= MUSIC_LIMIT) return abort(new Error('音乐库最多 12 首，请先移除不用的音乐。'));
      if (request.result.reduce((total, item) => total + item.bytes, 0) + record.bytes > MUSIC_BYTE_LIMIT) return abort(new Error('音乐合计最多 128 MB，请先移除部分音乐。'));
      store.put(record); tx.objectStore('files').put({ id: record.id, blob });
    }; return record;
  });
}
export const deleteMusic = id => transaction(['tracks', 'files'], 'readwrite', tx => {
  tx.objectStore('tracks').delete(id); tx.objectStore('files').delete(id);
});
export const getMusicPreferences = () => transaction(['settings'], 'readonly', tx => {
  const request = tx.objectStore('settings').get('playback');
  return () => request.result?.value || { id: null, enabled: false, volume: .2, loop: true };
});
export const saveMusicPreferences = value => transaction(['settings'], 'readwrite', tx => {
  const config = musicConfig(value); tx.objectStore('settings').put({ id: 'playback', value: { id: config?.id || null, enabled: !!value.enabled, volume: config?.volume ?? .2, loop: config?.loop ?? true } });
});
