import { createLocalStore } from './idb-store.js';
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE } from './image-annotation.js';

export const MATERIAL_LIMIT = 12;
export const MATERIAL_BYTE_LIMIT = 16 * 1024 * 1024;
const raster = blob => blob instanceof Blob && ['image/png', 'image/webp', 'image/jpeg'].includes(blob.type);
const transaction = createLocalStore({ name: 'yinglu-image-materials', stores: ['materials', 'images'], label: '素材' });
export const listImageMaterials = () => transaction(['materials'], 'readonly', tx => {
  const request = tx.objectStore('materials').getAll();
  return () => request.result.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
});
export function saveImageMaterial({ name, blob, thumbnail, width, height }) {
  if (!raster(blob) || !blob.size || blob.size > IMAGE_MAX_BYTES || !raster(thumbnail) || !thumbnail.size || thumbnail.size > 128 * 1024
    || !Number.isInteger(width) || !Number.isInteger(height) || Math.min(width, height) < 1 || Math.max(width, height) > IMAGE_MAX_EDGE)
    return Promise.reject(new Error('图片素材无效，请重新导入。'));
  const record = { id: crypto.randomUUID(), name: String(name || '图片').slice(0, 100), width, height,
    bytes: blob.size + thumbnail.size, thumbnail, createdAt: Date.now() };
  return transaction(['materials', 'images'], 'readwrite', (tx, abort) => {
    const store = tx.objectStore('materials'), request = store.getAll();
    request.onsuccess = () => {
      const all = request.result;
      if (all.length >= MATERIAL_LIMIT) return abort(new Error(`最多准备 ${MATERIAL_LIMIT} 张素材，请先移除不用的图片。`));
      if (all.reduce((sum, item) => sum + item.bytes, 0) + record.bytes > MATERIAL_BYTE_LIMIT)
        return abort(new Error('素材合计最多 16 MB，请先移除部分图片。'));
      store.put(record); tx.objectStore('images').put({ id: record.id, blob });
    };
    return record;
  });
}
export const getImageMaterial = id => transaction(['images'], 'readonly', tx => {
  const request = tx.objectStore('images').get(id); return () => request.result?.blob;
});
export const deleteImageMaterial = id => transaction(['materials', 'images'], 'readwrite', tx => {
  tx.objectStore('materials').delete(id); tx.objectStore('images').delete(id);
});
