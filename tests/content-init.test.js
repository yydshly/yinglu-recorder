import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../content.js', import.meta.url), 'utf8');

function page({ longTasksSupported = true } = {}) {
  const listeners = [];
  const emitted = [], frames = new Map(), timers = new Map(), observers = [];
  let frameId = 0, timerId = 0, now = 0;
  const fault = { svg: false }, imageCalls = { draws: 0, closes: 0 }, pointCalls = { appends: 0, clears: 0 };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attributes = {}; this.handlers = {}; this.dataset = {}; this.value = '';
      if(tag === 'polyline') { this.samples=[]; this.points={clear:()=>{pointCalls.clears++;this.samples=[];},appendItem:p=>{pointCalls.appends++;this.samples.push(p);}}; }
    }
    createSVGPoint() { return {x:0,y:0}; }
    removeAttribute(key) { delete this.attributes[key]; }
    get isConnected() { return this === document.documentElement || !!this.parent?.isConnected; }
    get lastElementChild() { return this.children.at(-1); }
    get scrollHeight() { return Math.max(parseFloat(this.style.height) - 2 || 0, this.value.split('\n').length * 35 + 8); }
    set innerHTML(value) { throw new TypeError('This document requires TrustedHTML assignment'); }
    append(...children) { children.forEach(child => { if (child.parent) child.remove(); child.parent = this; this.children.push(child); }); }
    insertBefore(child, before) { if (child.parent) child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index, 0, child); child.parent = this; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return key === 'points' && this.samples?.length ? this.samples.map(p=>`${p.x},${p.y}`).join(' ') : this.attributes[key]; }
    closest(selector) { return selector === '[data-id]' && this.attributes['data-id'] ? this : this.parent?.closest(selector); }
    attachShadow() { this.shadowRoot = new Element('shadow'); this.shadowRoot.parent = this; return this.shadowRoot; }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName.toLowerCase() === selector) return child;
        const found = child.querySelector(selector); if (found) return found;
      }
      return null;
    }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
    dispatch(type, extra = {}) { for (const handler of this.handlers[type] || []) handler({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
    setPointerCapture(id) { (this.capturedPointers ||= new Set()).add(id); }
    hasPointerCapture(id) { return !!this.capturedPointers?.has(id); }
    releasePointerCapture(id) { this.capturedPointers?.delete(id); }
    focus() {}
    getBoundingClientRect() { return { width: parseFloat(this.style.width) || 260, height: parseFloat(this.style.height) || 90 }; }
    getContext() { return { drawImage() { imageCalls.draws++; } }; }
  }
  const document = {
    documentElement: new Element('html'),
    handlers: {}, visibilityState: 'visible',
    createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => { if (fault.svg) throw new Error('SVG setup failed'); return new Element(tag); },
    querySelectorAll: tag => document.documentElement.children.filter(child => child.tagName.toLowerCase() === tag),
    addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); },
    removeEventListener(type, handler) { this.handlers[type] = (this.handlers[type] || []).filter(item => item !== handler); }
  };
  class PerformanceObserver {
    static supportedEntryTypes = longTasksSupported ? ['longtask'] : [];
    constructor(callback) { this.callback = callback; this.active = false; this.entries = []; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    takeRecords() { const entries = this.entries; this.entries = []; return entries; }
  }
  const context = vm.createContext({ document, innerWidth: 1200, innerHeight: 800,
    addEventListener(type, handler) { (document.handlers['window:' + type] ||= []).push(handler); },
    crypto: webcrypto, structuredClone, performance: { now: () => now }, PerformanceObserver, atob, Blob,
    createImageBitmap: async () => ({ width: 400, height: 200, close() { imageCalls.closes++; } }),
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, due: now + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
    chrome: { runtime: { id: 'test', sendMessage: async message => emitted.push(message), onMessage: { addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1) } } }
  });
  const command = (type, options) => { let reply; listeners[0]({ target: 'overlay', type, options }, {}, value => reply = value); return reply; };
  const commandAsync = (type, options) => new Promise(resolve => listeners[0]({ target: 'overlay', type, options }, {}, resolve));
  const svg = () => document.documentElement.children[0].shadowRoot.querySelector('svg');
  const pointer = (type, x, y, target = svg()) => svg().dispatch(type, { target, button: 0, pointerId: 1, clientX: x, clientY: y });
  const draw = (x, y) => { pointer('pointerdown', x, y); pointer('pointermove', x + 80, y + 80); pointer('pointerup', x + 80, y + 80); };
  const frame = (delta = 16) => { now += delta; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); };
  const advance = delta => {
    now += delta;
    const due = [...timers].filter(([, timer]) => timer.due <= now);
    for (const [id, timer] of due) if (timers.delete(id)) timer.fn();
  };
  const event = (type, detail = {}) => { for (const handler of [...document.handlers[type] || []]) handler(detail); };
  const longTask = (duration, { startTime = now, queued = false } = {}) => {
    for (const observer of observers.filter(item => item.active)) {
      const entry = { startTime, duration };
      if (queued) observer.entries.push(entry); else observer.callback({ getEntries: () => [entry] });
    }
  };
  const samples = phase => emitted.filter(message => message.type === 'PERF_SAMPLE' && (!phase || phase === message.phase));
  return { context, document, fault, listeners, emitted, command, commandAsync, imageCalls, pointCalls, svg, pointer, draw, frame, frames, timers, observers, advance, event, longTask, samples, run: () => vm.runInContext(source, context) };
}

const imageOptions = { image: { src: 'data:image/png;base64,aGVsbG8=' } };

test('长笔迹逐帧仅追加新 SVG 点，复用路径和命中节点', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'pen' }); p.pointer('pointerdown', 0, 0);
  const group = p.svg().children[0], path = group.querySelector('polyline'), hit = group.lastElementChild;
  for (let i = 1; i <= 2000; i++) { p.pointer('pointermove', i % 1000, i * 7 % 700); p.frame(); }
  assert.equal(p.svg().children[0], group); assert.equal(group.querySelector('polyline'), path); assert.equal(group.lastElementChild, hit);
  assert.equal(p.pointCalls.clears, 1); assert.ok(p.pointCalls.appends <= 2001);
  p.pointer('pointerup', 1111, 777); assert.ok(path.getAttribute('points').endsWith('1111,777'));
});

test('长笔迹拖动与缩放只更新矩阵，松开后才分配新点数组并保持线宽', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'pen' }); p.pointer('pointerdown', 0, 0);
  for (let i = 1; i <= 3000; i++) p.pointer('pointermove', i % 1000, i * 7 % 700);
  p.pointer('pointerup', 1000, 700); p.command('SET', { tool: 'select' });
  const group = p.svg().children[0], path = group.querySelector('polyline'), original = path.getAttribute('points');
  const stats = () => p.command('PING', {resources:true}).resources;
  const points = stats().scenePoints;
  p.pointer('pointerdown', 0, 0, group.lastElementChild);
  const appends = p.pointCalls.appends;
  for (let i = 1; i <= 100; i++) { p.pointer('pointermove', i, i); p.frame(); }
  assert.equal(stats().retainedPoints, points); assert.equal(p.pointCalls.appends, appends);
  assert.equal(path.getAttribute('transform'), 'matrix(1 0 0 1 100 100)'); assert.equal(path.getAttribute('points'), original);
  p.pointer('pointerup', 120, 150);
  const moved = path.getAttribute('points'); assert.ok(moved.startsWith('120,150 ')); assert.equal(path.getAttribute('transform'), undefined);
  assert.equal(stats().retainedPoints, 2 * points);
  const handle = p.svg().children.find(n=>n.getAttribute('data-handle'));
  p.pointer('pointerdown', 600, 400, handle); p.pointer('pointermove', 700, 435); p.frame();
  assert.match(path.getAttribute('transform'), /^matrix\(1\.1 0 0 1\.05 /);
  assert.equal(path.getAttribute('vector-effect'), 'non-scaling-stroke'); assert.equal(path.getAttribute('points'), moved);
  p.command('SET', {color:'#123456'}); // Finish mid-drag before a style edit.
  assert.equal(path.getAttribute('transform'), undefined); const resized = path.getAttribute('points'); assert.notEqual(resized, moved);
  p.command('UNDO'); assert.equal(path.getAttribute('points'), resized);
  p.command('UNDO'); assert.equal(path.getAttribute('points'), moved);
  p.command('UNDO'); assert.equal(path.getAttribute('points'), original);
  p.command('REDO'); assert.equal(path.getAttribute('points'), moved);
});

test('取消指针和切换工具均提交最后变换并移除临时矩阵', () => {
  for (const action of ['cancel','tool']) {
    const p = page(); p.run(); p.command('SET', {tool:'pen'}); p.draw(10,10); p.command('SET',{tool:'select'});
    const group=p.svg().children[0], path=group.querySelector('polyline');
    p.pointer('pointerdown',10,10,group.lastElementChild); p.pointer('pointermove',60,70); p.frame();
    if(action==='cancel') p.pointer('pointercancel',60,70); else p.command('SET',{tool:'pointer'});
    assert.equal(path.getAttribute('transform'),undefined); assert.ok(path.getAttribute('points').startsWith('60,70 '));
    p.command('UNDO'); assert.ok(path.getAttribute('points').startsWith('10,10 '));
  }
});

test('笔迹颜色编辑共享点数组，撤销重做保留各版本而非复制全部点', () => {
  const p = page(); p.run(); p.context.structuredClone = () => { throw new Error('不能全量复制图形'); };
  p.command('SET', { tool: 'pen' }); p.pointer('pointerdown', 10, 10);
  for (let i = 1; i <= 200; i++) p.pointer('pointermove', i * 5 % 1100, i * 7 % 700);
  p.pointer('pointerup', 1000, 600);
  const originalPath = p.svg().children[0].querySelector('polyline'), original = originalPath.getAttribute('points');
  p.command('SET', { tool: 'select' });
  p.pointer('pointerdown', 10, 10, p.svg().children[0].lastElementChild); p.pointer('pointerup', 10, 10);
  for (let i = 0; i < 30; i++) p.command('SET', { color: i % 2 ? '#ff0000' : '#00ff00' });
  const stats = p.command('PING', { resources: true }).resources;
  assert.equal(p.svg().children[0].querySelector('polyline'), originalPath);
  assert.equal(stats.retainedPoints, stats.scenePoints); assert.equal(stats.undo, 31);
  p.command('UNDO'); assert.equal(p.svg().children[0].getAttribute('stroke'), '#00ff00');
  p.command('REDO'); assert.equal(p.svg().children[0].getAttribute('stroke'), '#ff0000');
  assert.equal(p.svg().children[0].querySelector('polyline').getAttribute('points'), original);
});

test('连续拖动只在动画帧变换笔迹，松开仍提交最后坐标且撤销恢复原笔迹', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'pen' }); p.draw(20, 20);
  const original = p.svg().children[0].querySelector('polyline').getAttribute('points');
  p.command('SET', { tool: 'select' }); p.pointer('pointerdown', 20, 20, p.svg().children[0].lastElementChild);
  const before = p.command('PING', { resources: true }).resources.undo;
  for (let i = 1; i <= 100; i++) p.pointer('pointermove', 20 + i, 20 + i);
  assert.equal(p.frames.size, 1); assert.equal(p.command('PING', { resources: true }).resources.undo, before);
  p.frame(); assert.equal(p.command('PING', { resources: true }).resources.undo, before + 1);
  p.pointer('pointerup', 160, 160);
  const moved = p.svg().children[0].querySelector('polyline').getAttribute('points'); assert.match(moved, /^160,160 /);
  p.command('UNDO'); assert.equal(p.svg().children[0].querySelector('polyline').getAttribute('points'), original);
  p.command('REDO'); assert.equal(p.svg().children[0].querySelector('polyline').getAttribute('points'), moved);
});

test('超长笔迹持续采样而不冻结，历史点数预算会回收最旧版本', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'pen' }); p.pointer('pointerdown', 0, 0);
  for (let i = 1; i <= 10000; i++) p.pointer('pointermove', i * 11 % 1100, i * 13 % 700);
  p.pointer('pointerup', 0, 500);
  let stats = p.command('PING', { resources: true }).resources;
  assert.ok(stats.scenePoints <= stats.limits.strokePoints);
  assert.ok(p.svg().children[0].querySelector('polyline').getAttribute('points').endsWith('0,500'));
  p.command('SET', { tool: 'select' });
  for (let i = 0; i < 49; i++) {
    p.pointer('pointerdown', 0, 0, p.svg().children[0].lastElementChild);
    p.pointer('pointermove', 2, 2); p.pointer('pointerup', 2, 2);
  }
  stats = p.command('PING', { resources: true }).resources;
  assert.ok(stats.retainedPoints <= stats.limits.retainedPoints); assert.ok(stats.undo < 50);
  assert.ok(stats.undo > 1); assert.ok(stats.scenePoints <= stats.limits.scenePoints);
});

test('图形数量和历史引用数有界，达到上限保留现有图形并提示', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' });
  for (let i = 0; i < 550; i++) p.draw(i % 1000, i % 600);
  const stats = p.command('PING', { resources: true }).resources;
  assert.equal(stats.shapes, stats.limits.shapes); assert.ok(stats.references <= stats.limits.historyReferences);
  assert.ok(p.emitted.some(message => message.type === 'ANNOTATION_ERROR'));
});

test('录完只保留最终标注可恢复，释放旧撤销重做历史', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'pen' });
  p.draw(20, 20); p.draw(40, 40); p.command('UNDO');
  const points = p.svg().children[0].querySelector('polyline').getAttribute('points');
  p.command('END'); const stats = p.command('PING', { resources: true }).resources;
  assert.equal(stats.undo, 0); assert.equal(stats.redo, 0); assert.equal(stats.retainedPoints, stats.scenePoints);
  assert.equal(p.svg().children.length, 0); p.command('RESTORE');
  assert.equal(p.svg().children[0].querySelector('polyline').getAttribute('points'), points);
});

test('图片像素预算覆盖当前场景和历史引用，超额导入释放位图且不增加图形', async () => {
  const p = page(); p.context.createImageBitmap = async () => ({ width: 1600, height: 1600, close() { p.imageCalls.closes++; } }); p.run();
  for (let i = 0; i < 6; i++) assert.equal((await p.commandAsync('INSERT_IMAGE', imageOptions)).ok, true);
  const seventh = await p.commandAsync('INSERT_IMAGE', imageOptions);
  assert.equal(seventh.ok, false); assert.match(seventh.error, /图片较多/);
  const stats = p.command('PING', { resources: true }).resources;
  assert.equal(stats.shapes, 6); assert.ok(stats.imageBytes <= stats.limits.imageBytes); assert.equal(p.imageCalls.closes, 7);
});
test('图片只绘制一次，移动、等比缩放和工具切换复用原像素节点', async () => {
  const p = page(); p.run();
  assert.equal((await p.commandAsync('INSERT_IMAGE', imageOptions)).ok, true);
  const group = p.svg().children[0], box = group.querySelector('foreignobject'), raster = box.querySelector('canvas');
  const x = Number(box.getAttribute('x')), y = Number(box.getAttribute('y'));
  assert.equal(p.imageCalls.draws, 1); assert.equal(p.imageCalls.closes, 1);
  p.pointer('pointerdown', x + 10, y + 10, group.lastElementChild);
  p.pointer('pointermove', x - 110, y + 50); p.pointer('pointerup', x - 110, y + 50);
  assert.equal(Number(box.getAttribute('x')), x - 120); assert.equal(Number(box.getAttribute('y')), y + 40);
  const handle = p.svg().children.find(node => node.getAttribute('data-handle'));
  const hx = Number(box.getAttribute('x')) + 407, hy = Number(box.getAttribute('y')) + 207;
  p.pointer('pointerdown', hx, hy, handle); p.pointer('pointermove', hx + 80, hy + 10); p.pointer('pointerup', hx + 80, hy + 10);
  assert.equal(Number(box.getAttribute('width')) / Number(box.getAttribute('height')), 2);
  assert.equal(Number(box.getAttribute('width')), 480);
  for (const tool of ['pointer', 'rect', 'text', 'select']) p.command('SET', { tool });
  assert.equal(p.svg().children[0], group); assert.equal(box.querySelector('canvas'), raster); assert.equal(p.imageCalls.draws, 1);
});

test('图片撤销重做、删除及结束恢复都保留同一份像素，新录制释放旧图片', async () => {
  const p = page(); p.run(); await p.commandAsync('INSERT_IMAGE', imageOptions);
  const raster = p.svg().children[0].querySelector('canvas');
  p.command('UNDO'); assert.equal(p.svg().children.length, 0);
  p.command('REDO'); assert.equal(p.svg().children[0].querySelector('canvas'), raster);
  const group = p.svg().children[0]; p.pointer('pointerdown', 800, 30, group.lastElementChild); p.pointer('pointerup', 800, 30);
  p.command('DELETE'); assert.equal(p.svg().children.length, 0);
  p.command('UNDO'); assert.equal(p.svg().children[0].querySelector('canvas'), raster);
  p.command('END'); assert.equal(p.svg().children.length, 0);
  assert.equal(raster.width, 0); assert.equal(p.command('PING', {resources:true}).resources.imageBytes, 0);
  await p.commandAsync('RESTORE'); assert.equal(p.svg().children[0].querySelector('canvas'), raster);
  p.command('END'); p.command('BEGIN', { sessionId: 'new', diagnostics: false });
  assert.equal(p.svg().children.length, 0); assert.equal(raster.width, 0); assert.equal(p.imageCalls.draws, 2);
});

test('区域录制中图片初始位置按原框选CSS范围放置，不改变范围或触发误停', async () => {
  const p = page(); p.run();
  p.command('BEGIN', { sessionId: 'recording', crop: { viewportWidth: 1200, viewportHeight: 800 }, diagnostics: false });
  const region = { x: .25, y: .25, width: .25, height: .5, viewportWidth: 1200, viewportHeight: 800 };
  await p.commandAsync('INSERT_IMAGE', { ...imageOptions, region, sessionId: 'recording' });
  const box = p.svg().children[0].querySelector('foreignobject');
  assert.ok(Number(box.getAttribute('x')) >= 300); assert.ok(Number(box.getAttribute('x')) + Number(box.getAttribute('width')) <= 600);
  assert.ok(Number(box.getAttribute('y')) >= 200); assert.ok(Number(box.getAttribute('y')) + Number(box.getAttribute('height')) <= 600);
  p.event('window:resize'); assert.equal(p.emitted.some(e => e.type === 'VIEWPORT_RESIZE'), false);
});

test('归档图片释放全部像素而保留压缩数据，恢复后尺寸、坐标及像素节点一致', async () => {
  const p=page();p.run();await p.commandAsync('INSERT_IMAGE',imageOptions);
  const box=p.svg().children[0].querySelector('foreignobject'),raster=box.querySelector('canvas'),x=box.getAttribute('x');
  const before=p.command('PING',{resources:true}).resources;p.command('END');
  const after=p.command('PING',{resources:true}).resources;
  assert.ok(before.imageBytes>0);assert.equal(after.imageBytes,0);assert.equal(after.storedImageBytes,before.storedImageBytes);assert.ok(after.storedImageBytes>0);
  assert.equal((await p.commandAsync('RESTORE')).ok,true);const restored=p.svg().children[0].querySelector('foreignobject');
  assert.equal(restored.getAttribute('x'),x);assert.equal(restored.querySelector('canvas'),raster);assert.equal(raster.width,400);assert.equal(raster.height,200);
});

test('图片恢复中清空或开始新录制，迟到解码关闭且不复活旧标注',async()=>{
  for(const command of ['CLEAR','BEGIN']) {
    const p=page();p.run();await p.commandAsync('INSERT_IMAGE',imageOptions);p.command('END');
    let release;p.context.createImageBitmap=()=>new Promise(resolve=>{release=resolve;});const restoring=p.commandAsync('RESTORE');
    p.command(command,{sessionId:'next'});let closed=0;release({width:400,height:200,close(){closed++;}});
    assert.equal((await restoring).ignored,true);assert.equal(closed,1);assert.equal(p.svg().children.length,0);
    if(command==='BEGIN')assert.equal(p.command('PING',{resources:true}).resources.storedImageBytes,0);
    else {p.context.createImageBitmap=async()=>({width:400,height:200,close(){}});assert.equal((await p.commandAsync('UNDO')).ok,true);assert.equal(p.svg().children[0].querySelector('canvas').width,400);}
  }
});

test('恢复解码超时可重试，底层仍未结束时不叠加解码器',async()=>{
  const p=page();p.run();await p.commandAsync('INSERT_IMAGE',imageOptions);p.command('END');let release,calls=0,closed=0;
  p.context.createImageBitmap=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const restoring=p.commandAsync('RESTORE');p.advance(10001);assert.equal((await restoring).ok,false);
  assert.equal((await p.commandAsync('RESTORE')).ok,false);assert.equal(calls,1);
  release({width:400,height:200,close(){closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
  p.context.createImageBitmap=async()=>({width:400,height:200,close(){}});assert.equal((await p.commandAsync('RESTORE')).ok,true);
});

test('图片解码期间结束、清空或换录制后，迟到图片不会重新出现', async () => {
  for (const action of ['END', 'CLEAR', 'BEGIN']) {
    const p = page(); p.run(); let ready;
    p.command('BEGIN', { sessionId: 'first', diagnostics: false });
    p.context.createImageBitmap = () => new Promise(resolve => { ready = resolve; });
    const pending = p.commandAsync('INSERT_IMAGE', { ...imageOptions, sessionId: 'first' });
    p.command(action, { sessionId: action === 'BEGIN' ? 'second' : 'first', diagnostics: false });
    ready({ width: 400, height: 200, close() { p.imageCalls.closes++; } });
    assert.equal((await pending).ok, false); assert.equal(p.svg().children.length, 0); assert.equal(p.imageCalls.closes, 1);
  }
});

test('拒绝远程图片、SVG、大尺寸以及错误录制会话，不改变已有标注', async () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' }); p.draw(100, 100);
  for (const src of ['https://example.test/a.png', 'data:image/svg+xml;base64,aGVsbG8=', 'data:image/png;base64,!!!']) assert.equal((await p.commandAsync('INSERT_IMAGE', { image: { src } })).ok, false);
  p.context.createImageBitmap = async () => ({ width: 2000, height: 1000, close() { p.imageCalls.closes++; } });
  assert.equal((await p.commandAsync('INSERT_IMAGE', imageOptions)).ok, false);
  assert.equal((await p.commandAsync('INSERT_IMAGE', { ...imageOptions, sessionId: 'old' })).ok, false);
  assert.equal(p.svg().children.length, 1); assert.equal(p.imageCalls.draws, 0); assert.equal(p.imageCalls.closes, 1);
});

test('标注初始化不依赖 innerHTML，能在要求 TrustedHTML 的页面上完成握手', () => {
  const p = page();
  assert.equal(p.run().ok, true);
  let reply;
  p.listeners[0]({ target: 'overlay', type: 'PING' }, {}, value => reply = value);
  assert.equal(reply.ok, true); assert.equal(reply.width, 1200);
});

test('区域录制网页尺寸变化只通知一次，结束后停止监听本次范围', () => {
  const p = page(); p.run();
  // The BEGIN handler's compositor acknowledgement is asynchronous; the
  // underlying viewport guard is installed synchronously before capture.
  p.context.setTimeout = () => 1; p.context.clearTimeout = () => {};
  p.command('BEGIN', { sessionId: 'session', crop: { viewportWidth: 1200, viewportHeight: 800 } });
  p.context.innerWidth = 1000;
  for (const handler of p.document.handlers['window:resize']) { handler(); handler(); }
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 1);
  assert.equal(p.emitted.find(message => message.type === 'VIEWPORT_RESIZE').sessionId, 'session');
  p.command('END'); p.context.innerWidth = 900;
  for (const handler of p.document.handlers['window:resize']) handler();
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 1);
});

test('开始采集造成 CSS 高度变化时先等稳定并重新武装，录制后变化仍通知', () => {
  const p = page(); p.run();
  p.command('BEGIN', { sessionId: 'session', crop: { viewportWidth: 1200, viewportHeight: 800 }, deferViewport: true });
  p.context.innerHeight = 740; p.event('window:resize');
  assert.equal(p.emitted.some(message => message.type === 'VIEWPORT_RESIZE'), false);
  let ready;
  p.listeners[0]({ target: 'overlay', type: 'CAPTURE_VIEWPORT', options: { sessionId: 'session' } }, {}, result => { ready = result; });
  p.advance(200); assert.equal(ready, undefined);
  p.context.innerHeight = 730; p.event('window:resize');
  p.advance(200); assert.equal(ready, undefined);
  p.advance(100); assert.equal(ready.ok, true); assert.equal(ready.height, 730);
  assert.equal(p.command('ARM_VIEWPORT', { sessionId: 'session', crop: { viewportWidth: 1200, viewportHeight: 730 } }).ok, true);
  // A reload notification can repeat BEGIN with its older crop metadata.
  p.command('BEGIN', { sessionId: 'session', crop: { viewportWidth: 1200, viewportHeight: 800 }, deferViewport: true });
  p.context.innerHeight = 729; p.event('window:resize');
  assert.equal(p.emitted.some(message => message.type === 'VIEWPORT_RESIZE'), false);
  p.context.innerHeight = 650; p.event('window:resize');
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 1);
  p.command('BEGIN', { sessionId: 'session', crop: { viewportWidth: 1200, viewportHeight: 730 } }); p.event('window:resize');
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 1);
});

test('点击、滚动、绘图、文字编辑和工具切换不触发区域尺寸变化', () => {
  const p = page(); p.run();
  p.command('BEGIN', { sessionId: 'fixed', crop: { viewportWidth: 1200, viewportHeight: 800 }, diagnostics: false });
  p.event('pointerdown', { clientX: 200, clientY: 150, composedPath: () => [] });
  p.context.scrollY = 600; p.event('window:scroll');
  p.command('SET', { tool: 'rect' }); p.draw(100, 100);
  p.command('SET', { tool: 'text' }); p.pointer('pointerdown', 300, 100);
  p.document.documentElement.children[0].shadowRoot.querySelector('textarea').value = '固定范围标注';
  p.command('SET', { tool: 'pointer' });
  p.event('window:resize');
  assert.equal(p.command('SET', {}).count, 2);
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 0);
  p.context.innerHeight = 700; p.event('window:resize');
  assert.equal(p.emitted.filter(message => message.type === 'VIEWPORT_RESIZE').length, 1);
});

test('稳定确认后再次变化或旧会话不能武装范围，END 立即结束等待', () => {
  const p = page(); p.run();
  p.command('BEGIN', { sessionId: 'current', crop: { viewportWidth: 1200, viewportHeight: 800 }, deferViewport: true });
  assert.equal(p.command('ARM_VIEWPORT', { sessionId: 'old', crop: { viewportWidth: 1200, viewportHeight: 800 } }).ok, false);
  p.context.innerHeight = 740;
  assert.equal(p.command('ARM_VIEWPORT', { sessionId: 'current', crop: { viewportWidth: 1200, viewportHeight: 800 } }).ok, false);
  let result;
  p.listeners[0]({ target: 'overlay', type: 'CAPTURE_VIEWPORT', options: { sessionId: 'current' } }, {}, reply => { result = reply; });
  assert.equal(p.command('END', { sessionId: 'old' }).ignored, true); assert.equal(result, undefined);
  p.command('END', { sessionId: 'current' });
  assert.equal(result.ok, false); assert.match(result.error, /取消/);
  p.advance(400); assert.equal(result.ok, false);
});

test('持续变化的 CSS 视口有明确确认超时，不无限等待', () => {
  const p = page(); p.run();
  p.command('BEGIN', { sessionId: 'current', crop: { viewportWidth: 1200, viewportHeight: 800 }, deferViewport: true });
  let result;
  p.listeners[0]({ target: 'overlay', type: 'CAPTURE_VIEWPORT', options: { sessionId: 'current' } }, {}, reply => { result = reply; });
  for (let i = 0; i < 30; i++) { p.context.innerHeight--; p.event('window:resize'); p.advance(100); }
  assert.equal(result.ok, false); assert.match(result.error, /仍在变化/);
});

test('初始化异常会清理半成品，第二次注入能正常重试', () => {
  const p = page(); p.fault.svg = true;
  const first = p.run();
  assert.equal(first.ok, false); assert.match(first.error, /SVG setup failed/);
  assert.equal(p.context.__yingluOverlay, undefined);
  assert.equal(p.document.documentElement.children.length, 0);
  p.fault.svg = false;
  assert.equal(p.run().ok, true);
  assert.equal(p.listeners.length, 1);
});

test('重复注入不会叠加标注层或消息监听器', () => {
  const p = page(); p.run();
  assert.equal(p.run().reused, true);
  assert.equal(p.listeners.length, 1);
  assert.equal(p.document.documentElement.children.length, 1);
});

test('旧版本遗留的初始化标记不会阻止连接恢复', () => {
  const p = page(); p.context.__yingluOverlay = true;
  assert.equal(p.run().ok, true);
  assert.equal(p.listeners.length, 1);
});

test('Escape 取消框选会恢复网页操作，并带上对应选择会话', () => {
  const p = page(); p.run();
  p.command('SET', { tool: 'rect' }); p.command('CROP', { selectionId: 'first' });
  p.pointer('pointerdown', 100, 100); p.pointer('pointermove', 200, 200);
  assert.equal(p.svg().hasPointerCapture(1), true);
  for (const handler of p.document.handlers.keydown) handler({ key: 'Escape', preventDefault() {} });
  assert.equal(p.command('PING').options.tool, 'pointer');
  assert.equal(p.svg().style.pointerEvents, 'none');
  assert.equal(p.svg().hasPointerCapture(1), false);
  assert.equal(p.emitted.find(message => message.type === 'CROP_CANCEL').selectionId, 'first');
  p.pointer('pointerup', 220, 220);
  assert.equal(p.emitted.some(message => message.type === 'CROP'), false);
});

test('Escape 结束绘制并释放捕获，后续移动不会继续修改标注', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' });
  p.pointer('pointerdown', 100, 100); p.pointer('pointermove', 180, 180);
  assert.equal(p.svg().hasPointerCapture(1), true);
  p.event('keydown', { key: 'Escape' });
  assert.equal(p.command('PING').options.tool, 'pointer');
  assert.equal(p.svg().hasPointerCapture(1), false);
  p.pointer('pointermove', 300, 300); p.pointer('pointerup', 300, 300); p.frame();
  assert.equal(p.svg().children[0].querySelector('rect').getAttribute('width'), 80);
  assert.equal(p.command('UNDO').count, 0);
});

for (const resize of [false, true]) test(`Escape 结束${resize ? '缩放' : '移动'}后不会因选中项已清空而抛异常`, () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' }); p.draw(100, 100); p.command('SET', { tool: 'select' });
  const group = p.svg().children[0];
  p.pointer('pointerdown', 120, 120, group); p.pointer('pointerup', 120, 120);
  const target = resize ? p.svg().children.find(node => node.getAttribute('data-handle')) : group;
  p.pointer('pointerdown', 180, 180, target); p.pointer('pointermove', 200, 200); p.frame();
  const before = { ...p.svg().children[0].querySelector('rect').attributes };
  p.event('keydown', { key: 'Escape' });
  assert.equal(p.svg().hasPointerCapture(1), false);
  assert.doesNotThrow(() => p.pointer('pointermove', 250, 250)); p.frame();
  assert.deepEqual(p.svg().children[0].querySelector('rect').attributes, before);
  p.pointer('pointerup', 250, 250);
  p.command('UNDO'); assert.equal(p.svg().children[0].querySelector('rect').getAttribute('x'), 100);
  assert.equal(p.svg().children[0].querySelector('rect').getAttribute('width'), 80);
});

test('拖动中清除图形后安全释放捕获，文字编辑 Escape 仍只取消当前输入', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' }); p.draw(100, 100); p.command('SET', { tool: 'select' });
  p.pointer('pointerdown', 120, 120, p.svg().children[0]); p.command('CLEAR');
  assert.equal(p.svg().hasPointerCapture(1), false);
  assert.doesNotThrow(() => p.pointer('pointermove', 200, 200));
  p.command('SET', { tool: 'text' }); p.pointer('pointerdown', 100, 100);
  const root = p.document.documentElement.children[0].shadowRoot, input = root.querySelector('textarea');
  input.value = '未提交';
  p.event('keydown', { key: 'Escape', composedPath: () => [input] });
  input.dispatch('keydown', { key: 'Escape', isComposing: false });
  assert.equal(root.querySelector('textarea'), null);
  assert.equal(p.command('PING').options.tool, 'text'); assert.equal(p.command('SET', {}).count, 0);
});

test('旧框选取消消息不会打断新一轮框选，完成选区携带新会话', () => {
  const p = page(); p.run();
  p.command('CROP', { selectionId: 'new' });
  assert.equal(p.command('CANCEL_CROP', { selectionId: 'old' }).ignored, true);
  assert.equal(p.command('PING').cropMode, true);
  p.draw(100, 100);
  assert.equal(p.emitted.find(message => message.type === 'CROP').selectionId, 'new');
});

test('纯选择不清除重做，实际移动才创建撤销记录', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' });
  p.draw(100, 100); p.draw(300, 100); p.command('UNDO'); p.command('SET', { tool: 'select' });
  const group = p.svg().children.find(node => node.tagName === 'G');
  p.pointer('pointerdown', 120, 120, group); p.pointer('pointerup', 120, 120, group);
  assert.equal(p.command('REDO').count, 2);
  p.pointer('pointerdown', 120, 120, group); p.pointer('pointermove', 150, 140); p.pointer('pointerup', 150, 140);
  p.command('UNDO');
  assert.equal(p.svg().children.find(node => node.tagName === 'G').querySelector('rect').getAttribute('x'), 100);
});

test('拖动一个图形不会重建其他图形节点', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' });
  p.draw(100, 100);
  const stable = p.svg().children[0];
  p.pointer('pointerdown', 300, 100); p.pointer('pointermove', 380, 180); p.frame();
  assert.equal(p.svg().children[0], stable);
  p.pointer('pointerup', 380, 180);
  assert.equal(p.svg().children[0], stable);
});

test('工具反复切换只更新命中区域，保留已有图形和文字节点', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' });
  for (let i = 0; i < 20; i++) p.draw(20 + i * 10, 100);
  p.command('SET', { tool: 'text' }); p.pointer('pointerdown', 400, 300);
  p.document.documentElement.children[0].shadowRoot.querySelector('textarea').value = '保留排版';
  p.command('SET', { tool: 'pointer' });
  const nodes = [...p.svg().children], text = nodes.at(-1).querySelector('div');
  for (const tool of ['select', 'text', 'pen', 'pointer', 'select']) {
    p.command('SET', { tool });
    assert.deepEqual(p.svg().children, nodes);
    assert.equal(nodes.at(-1).querySelector('div'), text);
    for (const group of nodes) assert.equal(group.lastElementChild.getAttribute('pointer-events'), ['select', 'text'].includes(tool) ? 'all' : 'none');
  }
  // Reused hit areas still select and move the correct shape.
  p.pointer('pointerdown', 40, 120, nodes[0].lastElementChild); p.pointer('pointermove', 50, 130); p.pointer('pointerup', 50, 130);
  assert.equal(p.svg().children[0].children[0].getAttribute('x'), 30);
});

test('文字保存编辑框宽度，重新编辑并仅调整尺寸也能提交', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'text' });
  p.pointer('pointerdown', 100, 100);
  const root = p.document.documentElement.children[0].shadowRoot;
  let input = root.querySelector('textarea');
  input.value = '保留框宽和换行\n 第二行'; input.style.width = '180px'; input.dispatch('blur');
  let box = root.querySelector('foreignobject');
  assert.equal(box.getAttribute('width'), 180);
  assert.equal(box.querySelector('div').textContent, '保留框宽和换行\n 第二行');
  const group = p.svg().children.find(node => node.tagName === 'G');
  p.svg().dispatch('dblclick', { target: group, clientX: 110, clientY: 110 });
  input = root.querySelector('textarea');
  assert.equal(input.style.width, '180px');
  input.style.width = '320px'; input.dispatch('blur'); box = root.querySelector('foreignobject');
  assert.equal(box.getAttribute('width'), 320);
  p.command('UNDO');
  assert.equal(root.querySelector('foreignobject').getAttribute('width'), 180);
});

test('默认标注与未开启诊断的录制不会留下持续性能探针', () => {
  const p = page(); p.run(); p.command('SET', { tool: 'rect' }); p.draw(100, 100);
  assert.equal(p.frames.size, 0); assert.equal(p.timers.size, 0);
  p.command('BEGIN', { sessionId: 'plain' }); p.frame(); p.frame();
  assert.equal(p.command('END', { sessionId: 'plain' }).ok, true);
  assert.equal(p.frames.size, 0); assert.equal(p.timers.size, 0);
  assert.equal(p.observers.length, 0); assert.equal(p.samples().length, 0);
});

test('基线立即应答且不阻塞 BEGIN，短基线报告实际时长并标记样本不足', () => {
  const p = page(); p.run();
  assert.equal(p.command('PERF_BASELINE', { sessionId: 'short' }).measuring, true);
  assert.equal(p.samples().length, 0);
  p.frame(); p.frame(); p.frame();
  p.command('BEGIN', { diagnostics: true, sessionId: 'short' });
  const baseline = p.samples('baseline')[0];
  assert.equal(baseline.sessionId, 'short'); assert.equal(baseline.sample.durationMs, 48);
  assert.equal(baseline.sample.enoughData, false); assert.equal(baseline.sample.raf.intervalCount, 2);
  assert.equal(baseline.sample.reason, 'phase-change');
});

test('没有录制前样本时基线为 null，录制报告调度节拍、长任务与 WebGL 丢失事件', () => {
  const p = page(); p.run(); p.command('BEGIN', { diagnostics: true, sessionId: 'recording' });
  const baseline = p.samples('baseline')[0].sample;
  assert.equal(baseline.raf, null); assert.equal(baseline.durationMs, 0);
  assert.equal(baseline.reason, 'not-measured-before-start'); assert.equal(baseline.enoughData, false);
  for (let index = 0; index < 125; index++) p.frame();
  p.longTask(60, { startTime: 1000 }); p.longTask(80, { startTime: 1500, queued: true });
  p.event('webglcontextlost', { preventDefault() { assert.fail('探针不能改变 WebGL 丢失事件的默认行为'); } });
  p.advance(0);
  const sample = p.samples('recording')[0].sample;
  assert.equal(sample.scope, 'top-document'); assert.equal(sample.metric, 'raf-cadence');
  assert.equal(sample.durationMs, 2000); assert.equal(sample.enoughData, true);
  assert.equal(sample.raf.intervalCount, 124); assert.equal(sample.raf.meanMs, 16);
  assert.equal(sample.raf.cadenceHz, 62.5); assert.equal(sample.raf.p95Ms, 16);
  assert.deepEqual({ ...sample.longTasks }, { supported: true, count: 2, totalMs: 140, maxMs: 80 });
  assert.equal(sample.webglContextLost, 1);
});

test('隐藏标签拆分采样且停止 RAF，返回前台不把隐藏停顿计入节拍', () => {
  const p = page(); p.run(); p.command('BEGIN', { diagnostics: true, sessionId: 'visible' });
  p.frame(); p.frame(); p.frame();
  p.document.visibilityState = 'hidden'; p.event('visibilitychange');
  assert.equal(p.samples('recording')[0].sample.visibility, 'visible');
  assert.equal(p.frames.size, 0);
  p.advance(60000);
  const hidden = p.samples('recording').at(-1).sample;
  assert.equal(hidden.visibility, 'hidden'); assert.equal(hidden.raf, null);
  assert.equal(hidden.visibleMs, 0); assert.equal(hidden.enoughData, false);
  p.document.visibilityState = 'visible'; p.event('visibilitychange');
  p.frame(); p.frame();
  p.command('END', { diagnostics: true, sessionId: 'visible' });
  const resumed = p.samples('recording').at(-1).sample;
  assert.equal(resumed.visibility, 'visible'); assert.equal(resumed.durationMs, 32);
  assert.equal(resumed.raf.maxMs, 16);
});

test('END 立即应答，恢复采样两秒后清理全部探针且重复 END 不重启', () => {
  const p = page(); p.run(); p.command('BEGIN', { diagnostics: true, sessionId: 'stop' });
  p.frame(); p.frame();
  assert.equal(p.command('END', { diagnostics: true, sessionId: 'stop' }).ok, true);
  assert.equal(p.samples('recovery').length, 0); assert.equal(p.frames.size, 1);
  p.command('END', { diagnostics: true, sessionId: 'stop' });
  assert.equal(p.timers.size, 1);
  for (let index = 0; index < 125; index++) p.frame();
  p.advance(0);
  assert.equal(p.samples('recovery').length, 1);
  assert.equal(p.samples('recovery')[0].sample.durationMs, 2000);
  assert.equal(p.frames.size, 0); assert.equal(p.timers.size, 0);
  assert.equal(p.observers.filter(observer => observer.active).length, 0);
  assert.equal(p.document.handlers.visibilitychange.length, 0);
  assert.equal(p.document.handlers.webglcontextlost.length, 0);
  p.command('END', { diagnostics: true, sessionId: 'stop' });
  assert.equal(p.frames.size, 0); assert.equal(p.timers.size, 0);
});

test('新基线会接替旧恢复探针，旧 END 不得中断新会话诊断', () => {
  const p = page(); p.run(); p.command('BEGIN', { diagnostics: true, sessionId: 'old' });
  p.frame(); p.frame(); p.command('END', { diagnostics: true, sessionId: 'old' });
  assert.equal(p.command('PERF_BASELINE', { sessionId: 'new' }).measuring, true);
  p.frame(); p.frame();
  p.command('END', { diagnostics: true, sessionId: 'old' });
  assert.equal(p.samples('baseline').filter(message => message.sessionId === 'new').length, 0);
  p.command('BEGIN', { diagnostics: true, sessionId: 'new' });
  assert.equal(p.samples('baseline').at(-1).sessionId, 'new');
  p.frame(); p.frame();
  p.command('END', { diagnostics: true, sessionId: 'old' });
  assert.equal(p.samples('recording').filter(message => message.sessionId === 'new').length, 0);
  p.advance(2000);
  assert.equal(p.samples('recording').at(-1).sessionId, 'new');
});

test('未支持长任务 API 时明确报告 null，独立基线一秒后停止', () => {
  const p = page({ longTasksSupported: false }); p.run();
  p.command('PERF_BASELINE', { sessionId: 'unsupported' });
  for (let index = 0; index < 60; index++) p.frame();
  p.advance(40);
  const sample = p.samples('baseline')[0].sample;
  assert.equal(sample.durationMs, 1000); assert.equal(sample.enoughData, true);
  assert.deepEqual({ ...sample.longTasks }, { supported: false, count: null, totalMs: null, maxMs: null });
  assert.equal(p.frames.size, 0); assert.equal(p.timers.size, 0);
});
