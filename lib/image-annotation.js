import { bounded } from './async.js';
import { imageDimensions } from './image-header.js';
let processing = false;
const nativeTasks = new Set();
function nativeTask(operation) {
  const task = Promise.resolve().then(operation); nativeTasks.add(task);
  task.then(() => nativeTasks.delete(task), () => nativeTasks.delete(task));
  return task;
}
const types = new Set(['image/png', 'image/jpeg', 'image/webp']);
export const IMAGE_MAX_EDGE = 1600;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

// Decode and bound the raster once, before sending it through extension messages.
// Re-encoding also keeps animated images and external references out of the overlay.
async function prepareRaster(file, withThumbnail = false, { signal, timeoutMs = 10000 } = {}) {
  if (!types.has(file?.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (!file.size || file.size > 10 * 1024 * 1024) throw new Error('请选择小于 10 MB 的图片。');
  const step = (operation, onLate) => bounded(operation, { signal, timeoutMs, onLate, message: '图片处理超时，请缩小图片后重试。' });
  let bitmap, canvas, preview;
  if (processing || nativeTasks.size) throw new Error('上一张图片仍在结束处理，请稍后重试。');
  processing = true;
  try {
    const source = await imageDimensions(file, blob => step(() => blob.arrayBuffer()));
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
    bitmap = await step(() => nativeTask(() => createImageBitmap(file, { imageOrientation: 'from-image',
      resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })), late => late.close());
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('浏览器未能安全缩小图片，请先缩小后导入。');
    canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法处理图片，请重新选择。');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close(); bitmap = undefined;
    const encode = (type, quality) => step(() => nativeTask(() => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片处理失败，请重新选择。')), type, quality))));
    let blob = await encode('image/png');
    if (blob.size > IMAGE_MAX_BYTES) blob = await encode('image/webp', .9);
    if (blob.size > IMAGE_MAX_BYTES) throw new Error('图片内容较大，请缩小尺寸后重试。');
    let thumbnail;
    if (withThumbnail) {
      preview = document.createElement('canvas');
      const ratio = Math.min(1, 192 / Math.max(canvas.width, canvas.height));
      preview.width = Math.max(1, Math.round(canvas.width * ratio));
      preview.height = Math.max(1, Math.round(canvas.height * ratio));
      const context = preview.getContext('2d');
      if (!context) throw new Error('无法生成图片缩略图。');
      context.drawImage(canvas, 0, 0, preview.width, preview.height);
      thumbnail = await step(() => nativeTask(() => new Promise((resolve, reject) => preview.toBlob(value => value ? resolve(value) : reject(new Error('无法生成图片缩略图。')), 'image/png'))));
      if (thumbnail.size > 128 * 1024) thumbnail = await step(() => nativeTask(() => new Promise(resolve => preview.toBlob(resolve, 'image/webp', .8))));
      if (!thumbnail || thumbnail.size > 128 * 1024) throw new Error('图片缩略图过大，请缩小图片后重试。');
    }
    return { blob, thumbnail, width: canvas.width, height: canvas.height };
  } catch (error) {
    if (error.name === 'InvalidStateError' || error.name === 'EncodingError') throw new Error('这张图片无法读取，请重新选择 PNG、JPG 或 WebP。');
    throw error;
  } finally { processing = false; bitmap?.close(); if (canvas) canvas.width = canvas.height = 0; if (preview) preview.width = preview.height = 0; }
}

export async function prepareAnnotationImage(file, options) {
  const { blob } = await prepareRaster(file, false, options);
  return { src: await imageBlobToDataURL(blob, options) };
}
export const prepareImageMaterial = (file, options) => prepareRaster(file, true, options);
export async function imageBlobToDataURL(blob, { signal, timeoutMs = 5000 } = {}) {
  let reader;
  try {
    return await bounded(() => new Promise((resolve, reject) => {
      reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取图片失败，请重新选择。'));
      reader.onabort = () => reject(new DOMException('已取消图片读取', 'AbortError'));
      reader.readAsDataURL(blob);
    }), { signal, timeoutMs, message: '读取图片超时，请重试。' });
  } finally {
    if (reader) { reader.onload = reader.onerror = reader.onabort = null; if (reader.readyState === 1) reader.abort(); }
  }
}
