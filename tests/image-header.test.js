import test from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions } from '../lib/image-header.js';
function exif(value=6) {
  const bytes=new Uint8Array(32),v=new DataView(bytes.buffer);
  bytes.set([69,120,105,102,0,0,73,73]); v.setUint16(8,42,true);v.setUint32(10,8,true);
  v.setUint16(14,1,true);v.setUint16(16,0x112,true);v.setUint16(18,3,true);v.setUint32(20,1,true);v.setUint16(24,value,true);
  return bytes;
}
export function jpeg(width=3200,height=1600,rotation=1) {
  const meta=exif(rotation), bytes=new Uint8Array(2+4+meta.length+13+2);let at=0;
  bytes.set([255,216,255,225,0,meta.length+2]);bytes.set(meta,6);at=6+meta.length;
  bytes.set([255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,0x11,0,255,218],at);
  return new Blob([bytes],{type:'image/jpeg'});
}
function webp(kind,width,height,rotation) {
  let data;
  if(kind==='VP8X') data=Uint8Array.from([0,0,0,0,(width-1)&255,((width-1)>>8)&255,((width-1)>>16)&255,(height-1)&255,((height-1)>>8)&255,((height-1)>>16)&255]);
  if(kind==='VP8 ') { data=new Uint8Array(10);data.set([0,0,0,0x9d,1,0x2a]);const v=new DataView(data.buffer);v.setUint16(6,width,true);v.setUint16(8,height,true); }
  if(kind==='VP8L') { data=new Uint8Array(5);data[0]=0x2f;new DataView(data.buffer).setUint32(1,((height-1)<<14)|(width-1),true); }
  const chunk=(name,value)=>{const b=new Uint8Array(8+value.length+(value.length&1));b.set([...name].map(c=>c.charCodeAt(0)));new DataView(b.buffer).setUint32(4,value.length,true);b.set(value,8);return b;};
  const chunks=[chunk(kind,data)];if(rotation)chunks.push(chunk('EXIF',exif(rotation)));
  const header=new Uint8Array(12);header.set([82,73,70,70,0,0,0,0,87,69,66,80]);new DataView(header.buffer).setUint32(4,4+chunks.reduce((s,c)=>s+c.length,0),true);
  return new Blob([header,...chunks],{type:'image/webp'});
}
test('JPEG普通与EXIF旋转尺寸在解码前读出，畸形段长不会越界',async()=>{
  assert.deepEqual(await imageDimensions(jpeg()),{width:3200,height:1600});
  assert.deepEqual(await imageDimensions(jpeg(3200,1600,6)),{width:1600,height:3200});
  await assert.rejects(imageDimensions(new Blob([new Uint8Array([255,216,255,225,255,255])],{type:'image/jpeg'})),/文件头/);
});
test('WebP有损、无损、扩展头和EXIF均识别像素尺寸',async()=>{
  for(const kind of ['VP8 ','VP8L','VP8X'])assert.deepEqual(await imageDimensions(webp(kind,3200,1600)),{width:3200,height:1600});
  assert.deepEqual(await imageDimensions(webp('VP8X',3200,1600,8)),{width:1600,height:3200});
});
test('JPEG和WebP巨幅尺寸拒绝，无需进入原生解码',async()=>{
  for(const file of [jpeg(10000,10000),webp('VP8X',10000,10000),webp('VP8L',10000,10000)])await assert.rejects(imageDimensions(file),/像素过大/);
});
