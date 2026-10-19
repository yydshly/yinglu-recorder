import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../lib/materials-panel.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const picture = () => ({ blob: new Blob(['image'], { type: 'image/png' }), thumbnail: new Blob(['thumb'], { type: 'image/png' }), width: 100, height: 50 });
const record = (id = 'one') => ({ id, name: `${id}.png`, createdAt: 1, bytes: 10, thumbnail: picture().thumbnail });

async function harness(t, options = {}) {
  const elements = new Map(), handlers = {}, calls = [], urls = [], revoked = [], channels = [];
  let records = options.records || [], allowed = true, usable = true, destination = { tabId: 7 }, next = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; }
    addEventListener(type, fn) { (this.handlers ||= {})[type] = fn; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(name, value) { this[name] = value; }
    click() { this.clicks = (this.clicks || 0) + 1; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  get('materials-card').open = options.open ?? true;
  const dependencies = {
    MATERIAL_LIMIT: 12,
    prepareImageMaterial: async file => { calls.push({ prepare: file.name }); return options.prepare ? options.prepare(file) : picture(); },
    imageBlobToDataURL: async blob => { calls.push({ serialize: blob }); return 'data:image/png;base64,aA=='; },
    listImageMaterials: async () => { calls.push({ list: true }); if (options.list) return options.list(); return records.slice(); },
    saveImageMaterial: async value => { calls.push({ save: value.name }); const item = { ...record(`saved-${++next}`), name: value.name }; records.push(item); return item; },
    getImageMaterial: async id => { calls.push({ get: id }); return options.read ? options.read(id) : picture().blob; },
    deleteImageMaterial: async id => { calls.push({ delete: id }); records = records.filter(item => item.id !== id); }
  };
  const values = { document: { hidden: false, getElementById: get, createElement: tag => new Element(tag),
    addEventListener: (type, fn) => { handlers[type] = fn; }, removeEventListener: type => { delete handlers[type]; } },
    window: { addEventListener: (type, fn) => { handlers[type] = fn; } },
    BroadcastChannel: class { constructor() { channels.push(this); } postMessage(value) { calls.push({ broadcast: value }); } close() { this.closed = true; } },
    materialTestDependencies: dependencies };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.method(URL, 'createObjectURL', blob => { urls.push(blob); return `blob:test-${urls.length}`; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const code = `const {${Object.keys(dependencies).join(',')}}=globalThis.materialTestDependencies;\n` + source.replace(/^import .*;\r?\n/gm, '');
  const module = await import('data:text/javascript;base64,' + Buffer.from(code + '\n//' + Math.random()).toString('base64'));
  const api = module.createMaterialShelf({ canImport: () => allowed, canUse: () => usable,
    captureDestination: () => ({ ...destination }), insert: async (image, target) => calls.push({ insert: image, target }),
    onBusy: value => calls.push({ busy: value }), onError: error => calls.push({ error: error.message }) });
  t.after(async () => { api.dispose(); await tick(); for (const [key, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  await tick();
  return { api, get, calls, urls, revoked, channels, handlers,
    allow: value => { allowed = value; api.render(); }, usable: value => { usable = value; api.render(); }, destination: value => { destination = value; },
    import: async names => { get('material-files').files = names.map(name => ({ name })); await get('material-files').onchange(); },
    rows: () => get('material-list').children };
}

test('准备多张图片只处理和保存素材，不立即插入网页；列表只创建小缩略图 URL', async t => {
  const h = await harness(t); h.usable(false); await h.import(['参数.png', '对比.png']);
  assert.equal(h.rows().length, 2); assert.equal(h.get('prepare-materials').disabled, false);
  assert.equal(h.calls.filter(call => call.prepare).length, 2); assert.equal(h.calls.filter(call => call.save).length, 2);
  assert.equal(h.calls.some(call => call.insert || call.get || call.serialize), false);
  assert.equal(h.urls.length, 2); assert.equal(h.urls.every(blob => blob.size === 5), true);
  assert.equal(h.rows()[0].children[0].disabled, true); assert.match(h.get('material-status').textContent, /已准备 2 张/);
});

test('收起素材区不查询或创建缩略图，展开才加载，收起释放缩略图', async t => {
  const h=await harness(t,{open:false,records:[record()]});assert.equal(h.calls.length,0);assert.equal(h.urls.length,0);
  h.get('materials-card').open=true;h.get('materials-card').handlers.toggle();await tick();assert.equal(h.urls.length,1);
  h.get('materials-card').open=false;h.get('materials-card').handlers.toggle();assert.equal(h.rows().length,0);assert.equal(h.revoked.length,1);
  h.channels[0].onmessage({data:'changed'});await tick();assert.equal(h.calls.filter(c=>c.list).length,1);
  h.get('materials-card').open=true;h.get('materials-card').handlers.toggle();await tick();assert.equal(h.rows().length,1);
});

test('点击备选图仅读取所选的已处理 Blob，并保留点击时的网页目标', async t => {
  const read = deferred(), h = await harness(t, { records: [record(), record('two')], read: () => read.promise });
  const pending = h.rows()[0].children[0].onclick();
  h.destination({ tabId: 8 }); read.resolve(picture().blob); await pending;
  assert.deepEqual(h.calls.find(call => call.insert).target, { tabId: 7 });
  assert.deepEqual(h.calls.filter(call => call.get).map(call => call.get), ['one']);
  assert.equal(h.calls.some(call => call.prepare), false); assert.equal(h.rows()[0].children[0].disabled, false);
});

test('移除备选素材删除本机副本并释放缩略图，不发送网页删除命令；关闭时释放剩余 URL 和通道', async t => {
  const h = await harness(t, { records: [record(), record('two')] });
  await h.rows()[0].children[1].onclick();
  assert.deepEqual(h.calls.filter(call => call.delete).map(call => call.delete), ['one']);
  assert.equal(h.rows().length, 1); assert.deepEqual(h.revoked, ['blob:test-1']);
  h.api.dispose(); assert.deepEqual(h.revoked, ['blob:test-1', 'blob:test-2']); assert.equal(h.channels[0].closed, true);
  assert.equal(h.calls.some(call => call.insert), false);
});

test('批量导入中非法图片不挡住其他图片，单次选择超过剩余数量不全部解码', async t => {
  const h = await harness(t, { records: Array.from({ length: 10 }, (_, i) => record(`old-${i}`)), prepare: async file => {
    if (file.name === '坏图.png') throw new Error('无法读取这张图片'); return picture();
  } });
  await h.import(['坏图.png', '有效.png', '多余.png']);
  assert.equal(h.calls.filter(call => call.prepare).length, 2);
  assert.equal(h.calls.filter(call => call.save).length, 1); assert.equal(h.rows().length, 11);
  assert.match(h.get('material-status').textContent, /已准备 1 张.*1 张未导入.*无法读取/);
});

test('准备过程中录制状态变化时不保存迟到图片，已结束的面板也不插图', async t => {
  const image = deferred(), h = await harness(t, { prepare: () => image.promise });
  const pending = h.import(['参数.png']); h.allow(false); image.resolve(picture()); await pending;
  assert.equal(h.calls.some(call => call.save), false); assert.match(h.get('material-status').textContent, /准备已停止/);
  h.allow(true); await h.api.refresh();
  const read = deferred();
  // A panel closing with a pending read must not send an insertion later.
  const h2 = await harness(t, { records: [record()], read: () => read.promise });
  const using = h2.rows()[0].children[0].onclick(); h2.api.dispose(); read.resolve(picture().blob); await using;
  assert.equal(h2.calls.some(call => call.insert), false);
});

test('素材读取失败恢复按钮；加载失败可重试且不把录制主流程设为忙碌', async t => {
  let broken = true;
  const h = await harness(t, { list: async () => { if (broken) throw new Error('database offline'); return [record()]; }, read: async () => undefined });
  assert.equal(h.get('material-retry').hidden, false); assert.equal(h.calls.some(call => call.busy), false);
  broken = false; await h.get('material-retry').onclick();
  assert.equal(h.rows().length, 1); assert.equal(h.get('material-retry').hidden, true);
  await h.rows()[0].children[0].onclick();
  assert.match(h.calls.find(call => call.error).error, /已被移除/); assert.equal(h.rows()[0].children[0].disabled, false);
});

test('图片处理超时停止整批，不写入失败图片', async t => {
  const h = await harness(t, { prepare: async () => { throw new DOMException('图片处理超时，请缩小图片后重试。','TimeoutError'); } });
  await h.import(['卡住.png','后续.png']);
  assert.equal(h.calls.filter(call => call.prepare).length,1); assert.equal(h.calls.some(call => call.save),false);
  assert.equal(h.get('prepare-materials').disabled,false); assert.match(h.get('material-status').textContent,/处理超时/);
});
