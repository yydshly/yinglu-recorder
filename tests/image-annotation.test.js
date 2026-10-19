import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAnnotationImage, prepareImageMaterial, imageBlobToDataURL } from '../lib/image-annotation.js';

function png(width = 3200, height = 1600) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137,80,78,71,13,10,26,10]); view.setUint32(8,13); bytes.set([73,72,68,82],12);
  view.setUint32(16,width); view.setUint32(20,height);
  return new Blob([bytes], { type: 'image/png' });
}
function harness(t, { pngBytes = 1000, webpBytes = 500 } = {}) {
  const calls = { closed: 0, formats: [], decodes: [] }, canvas = { getContext: () => ({ drawImage() { calls.drawn = [canvas.width, canvas.height]; } }), toBlob(done, type) { calls.formats.push(type); done({ size: type === 'image/png' ? pngBytes : webpBytes, type }); } };
  const values = { document: { createElement: () => canvas },
    createImageBitmap: async (file, options) => { calls.decodes.push(options); return { width: options.resizeWidth, height: options.resizeHeight, close() { calls.closed++; } }; },
    FileReader: class { readAsDataURL(blob) { this.result = `data:${blob.type};base64,aGVsbG8=`; queueMicrotask(() => this.onload()); } } };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(previous)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return { calls, canvas };
}
test('图片导入先限制像素并保持比例，以PNG保留透明通道，释放解码位图', async t => {
  const h = harness(t), result = await prepareAnnotationImage(png());
  assert.deepEqual(h.calls.drawn, [1600,800]); assert.equal(h.canvas.width, 0); assert.equal(h.canvas.height, 0); assert.equal(h.calls.closed, 1);
  assert.deepEqual(h.calls.formats, ['image/png']); assert.match(result.src, /^data:image\/png/);
});
test('大图片消息改用WebP压缩，仍然超出预算时明确失败并释放资源', async t => {
  const h = harness(t, { pngBytes: 3e6 });
  assert.match((await prepareAnnotationImage(png())).src, /^data:image\/webp/);
  assert.deepEqual(h.calls.formats, ['image/png', 'image/webp']); assert.equal(h.calls.closed, 1);
  h.canvas.toBlob = (done, type) => done({ size: 3e6, type });
  await assert.rejects(prepareAnnotationImage(png()), /缩小尺寸/); assert.equal(h.calls.closed, 2);
});
test('非法类型、空文件及超大文件在解码前拒绝', async () => {
  for (const file of [{ type: 'image/svg+xml', size: 100 }, { type: 'image/png', size: 0 }, { type: 'image/webp', size: 11e6 }]) await assert.rejects(prepareAnnotationImage(file), /请选择/);
});

test('备选图片仅解码一次，同时生成受限原图与192像素缩略图，不预先转成大型消息字符串', async t => {
  const h = harness(t), canvases = [];
  document.createElement = () => {
    const canvas = { getContext: () => ({ drawImage() { canvas.drawn = [canvas.width,canvas.height]; } }), toBlob(done, type) { done(new Blob(['pixels'], { type })); } };
    canvases.push(canvas); return canvas;
  };
  const result = await prepareImageMaterial(png());
  assert.equal(result.width, 1600); assert.equal(result.height, 800);
  assert.deepEqual(canvases.map(canvas => canvas.drawn), [[1600, 800], [192, 96]]);
  assert.equal(result.blob.type, 'image/png'); assert.equal(result.thumbnail.type, 'image/png');
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0)); assert.equal('src' in result, false); assert.equal(h.calls.closed, 1);
});

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('压缩小而像素巨大的图片在解码前拒绝，损坏文件头也不进入解码器', async t => {
  const h = harness(t);
  for (const file of [png(20000,20000), png(10000,3000), new Blob(['not png'], {type:'image/png'})])
    await assert.rejects(prepareAnnotationImage(file), /像素过大|文件头/);
  assert.equal(h.calls.decodes.length,0); assert.equal(h.calls.drawn,undefined);
});
test('解码挂起时取消立即返回，迟到位图关闭，未结束前不并行启动解码', async t => {
  const h = harness(t), deferred = gate(), controller = new AbortController(); let started = false;
  globalThis.createImageBitmap = () => { started = true; return deferred.promise; };
  const pending = prepareAnnotationImage(png(), {signal: controller.signal});
  await tick(); assert.equal(started,true); controller.abort();
  await assert.rejects(pending, {name:'AbortError'});
  await assert.rejects(prepareAnnotationImage(png()), /上一张图片/);
  deferred.resolve({width:1600,height:800,close(){h.calls.closed++;}}); await tick();
  assert.equal(h.calls.closed,1); assert.equal(h.calls.drawn,undefined);
});
test('解码和编码分别有等待超时，迟到解码关闭，编码失败释放画布', async t => {
  const h = harness(t), deferred = gate();
  globalThis.createImageBitmap = () => deferred.promise;
  await assert.rejects(prepareAnnotationImage(png(), {timeoutMs:15}), {name:'TimeoutError'});
  deferred.resolve({width:1600,height:800,close(){h.calls.closed++;}}); await tick();
  globalThis.createImageBitmap = async () => ({width:1600,height:800,close(){h.calls.closed++;}});
  let encoded; h.canvas.toBlob = done => { encoded = done; };
  await assert.rejects(prepareAnnotationImage(png(), {timeoutMs:15}), {name:'TimeoutError'});
  assert.equal(h.calls.closed,2); assert.equal(h.canvas.width,0); encoded(new Blob(['late'])); await tick();
});
test('FileReader取消会终止正在进行的读取并移除事件回调', async t => {
  harness(t); let reader;
  globalThis.FileReader = class { constructor(){reader=this;} readAsDataURL(){this.readyState=1;} abort(){this.aborted=true;this.readyState=2;} };
  const controller = new AbortController(), pending = imageBlobToDataURL(png(),{signal:controller.signal});
  controller.abort(); await assert.rejects(pending,{name:'AbortError'});
  assert.equal(reader.aborted,true); assert.equal(reader.onload,null);
});

test('解码器忽略缩小选项时拒绝继续，不创建原尺寸Canvas并关闭位图',async t=>{
  const h=harness(t);globalThis.createImageBitmap=async()=>({width:3200,height:1600,close(){h.calls.closed++;}});
  await assert.rejects(prepareAnnotationImage(png()),/安全缩小/);
  assert.equal(h.calls.closed,1);assert.equal(h.calls.drawn,undefined);assert.equal(h.canvas.width,undefined);
});
test('编码超时的原生任务结束前不叠加下一次图片处理，迟到回调结束后可重试',async t=>{
  const h=harness(t);let encoded;
  h.canvas.toBlob=done=>{encoded=done;};
  await assert.rejects(prepareImageMaterial(png(),{timeoutMs:15}),{name:'TimeoutError'});
  await assert.rejects(prepareAnnotationImage(png()),/上一张图片/);assert.equal(h.calls.decodes.length,1);
  encoded(new Blob(['late']));await tick();
  h.canvas.toBlob=(done,type)=>done(new Blob(['image'],{type}));
  assert.match((await prepareAnnotationImage(png())).src,/^data:image/);assert.equal(h.calls.decodes.length,2);
});
