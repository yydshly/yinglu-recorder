// Read dimensions before raster allocation. Compressed byte size alone cannot
// bound decoder memory (a tiny PNG can describe an enormous bitmap).
export const IMAGE_SOURCE_MAX_PIXELS = 20_000_000;
export const IMAGE_SOURCE_MAX_EDGE = 10000;
const checkSize = (width, height) => {
  if (width > IMAGE_SOURCE_MAX_EDGE || height > IMAGE_SOURCE_MAX_EDGE || width * height > IMAGE_SOURCE_MAX_PIXELS)
    throw new Error('图片像素过大，请缩小后导入（最多 2000 万像素，单边不超过 10000）。');
};
const invalid = () => new Error('图片文件头无法读取，请重新选择 PNG、JPG 或 WebP。');
function orientation(bytes) {
  let offset = bytes[0] === 0x45 && bytes[1] === 0x78 ? 6 : 0;
  if (bytes.length < offset + 8) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.length - offset);
  const little = view.getUint16(0) === 0x4949;
  if (!little && view.getUint16(0) !== 0x4d4d || view.getUint16(2, little) !== 42) return 1;
  const start = view.getUint32(4, little);
  if (start + 2 > view.byteLength) return 1;
  const count = Math.min(view.getUint16(start, little), 4096);
  for (let i = 0; i < count; i++) {
    const at = start + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    if (view.getUint16(at, little) === 0x112 && view.getUint16(at + 2, little) === 3 && view.getUint32(at + 4, little) === 1)
      return view.getUint16(at + 8, little);
  }
  return 1;
}
export async function imageDimensions(file, read = blob => blob.arrayBuffer()) {
  let width, height, rotated = false;
  const bytes = new Uint8Array(await read(file.slice(0, file.type === 'image/jpeg' ? 1024 * 1024 : 64)));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (b, at, length) => String.fromCharCode(...b.subarray(at, at + length));
  if (file.type === 'image/png') {
    if (bytes.length < 33 || ![137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) || view.getUint32(8) !== 13 || ascii(bytes,12,4) !== 'IHDR') throw invalid();
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (file.type === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw invalid();
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) throw invalid();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > bytes.length) throw invalid();
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) throw invalid();
      if (marker === 0xe1 && ascii(bytes,at+2,6) === 'Exif\0\0') rotated = [5,6,7,8].includes(orientation(bytes.subarray(at + 2, at + length)));
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) throw invalid();
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); checkSize(width,height);
      }
      at += length;
    }
  } else if (file.type === 'image/webp') {
    if (bytes.length < 20 || ascii(bytes,0,4) !== 'RIFF' || ascii(bytes,8,4) !== 'WEBP' || view.getUint32(4,true) + 8 > file.size) throw invalid();
    let at = 12, chunks = 0;
    while (at + 8 <= file.size && chunks++ < 256) {
      const chunk = new Uint8Array(await read(file.slice(at, at + 32)));
      if (chunk.length < 8) throw invalid();
      const cv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength), kind = ascii(chunk,0,4), size = cv.getUint32(4,true);
      if (at + 8 + size > file.size) throw invalid();
      const uint24 = p => chunk[p] + chunk[p+1] * 256 + chunk[p+2] * 65536;
      if (kind === 'VP8X' && size >= 10) { width = uint24(12) + 1; height = uint24(15) + 1; }
      if (kind === 'VP8 ' && size >= 10 && chunk[11] === 0x9d && chunk[12] === 1 && chunk[13] === 0x2a) { const w = cv.getUint16(14,true) & 16383, h = cv.getUint16(16,true) & 16383; checkSize(w,h); if (!width) {width=w;height=h;} }
      if (kind === 'VP8L' && size >= 5 && chunk[8] === 0x2f) { const bits = cv.getUint32(9,true); const w = (bits & 16383) + 1, h = ((bits >>> 14) & 16383) + 1; checkSize(w,h); if (!width) {width=w;height=h;} }
      if (kind === 'EXIF' && size <= 65536) rotated = [5,6,7,8].includes(orientation(new Uint8Array(await read(file.slice(at + 8, at + 8 + size)))));
      at += 8 + size + (size & 1);
    }
    if (chunks >= 256 && at + 8 <= file.size) throw invalid();
  }
  if (!width || !height) throw invalid();
  checkSize(width,height);
  return rotated ? { width: height, height: width } : { width, height };
}
