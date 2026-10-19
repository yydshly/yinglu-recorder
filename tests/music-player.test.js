import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { musicConfig, musicFileBlob } from '../lib/music-store.js';
const source = await readFile(new URL('../lib/music-player.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = () => { const blob = new Blob(['music'], { type: 'audio/mpeg' }); blob.name = 'example.mp3'; return blob; };

async function harness(t, options = {}) {
  const audios = [], urls = [], revoked = [], connections = [], changes = [];
  class Audio extends EventTarget {
    constructor() { super(); this.paused = true; this.duration = 3; this.currentTime = 0; this.ended = false; }
    load() { if (this.src && !options.pendingMetadata) queueMicrotask(() => this.dispatchEvent(new Event(options.badMetadata ? 'error' : 'loadedmetadata'))); }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    async play() { if (options.playGate) await options.playGate.promise; this.paused = false; this.dispatchEvent(new Event('play')); }
    pause() { const wasPlaying = !this.paused; this.paused = true; if (wasPlaying) this.dispatchEvent(new Event('pause')); }
  }
  const dependencies = { musicConfig, musicFileBlob, getMusicFile: options.read || (async () => file()), listMusic: async () => [{ id: 'song', name: 'test.mp3' }] };
  const values = { musicPlayerTest: dependencies, document: { createElement: () => { const audio = new Audio(); audios.push(audio); return audio; } } };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(old)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  t.mock.method(URL, 'createObjectURL', blob => { urls.push(blob); return 'blob:music'; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const api = await import('data:text/javascript;base64,' + Buffer.from(`const {${Object.keys(dependencies).join(',')}}=globalThis.musicPlayerTest;\n` + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random()).toString('base64'));
  const context = { currentTime: 0, destination: { monitor: true }, createMediaElementSource() { return { connect: target => connections.push(['source', target]), disconnect: () => connections.push(['close-source']) }; },
    createGain() { const gain = { gain: { value: 0, setTargetAtTime: value => { gain.gain.value = value; } }, connect: target => connections.push(['gain', target]), disconnect: () => connections.push(['close-gain']) }; return gain; } };
  const destination = { recording: true }, signal = new AbortController();
  return { api, audios, urls, revoked, connections, changes, signal,
    create: () => api.createRecordingMusic({ context, destination, config: { id: 'song', volume: .2, loop: true }, signal: signal.signal, onChange: value => changes.push(value) }) };
}

test('音乐配置限制音量与循环类型，文件按扩展名归一 MIME 并在读取前拒绝超大或未知格式', () => {
  assert.equal(musicConfig(null), null); assert.deepEqual(musicConfig({ id: 'song', volume: 0, loop: false, unused: true }), { id: 'song', volume: 0, loop: false });
  for (const value of [{ id: 'song', volume: NaN, loop: true }, { id: 'song', volume: 1.1, loop: true }, { id: 'song', volume: .2, loop: 'false' }]) assert.throws(() => musicConfig(value), /音乐设置无效/);
  assert.equal(musicFileBlob(file()).type, 'audio/mpeg');
  const bad = file(); bad.name = 'script.js'; assert.throws(() => musicFileBlob(bad), /请选择/);
  const big = new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]); big.name = 'big.wav'; assert.throws(() => musicFileBlob(big), /32 MB/);
});

test('导入只读取媒体元数据，成功或损坏文件都释放播放器和临时URL', async t => {
  const h = await harness(t); const prepared = await h.api.prepareMusicFile(file());
  assert.equal(prepared.duration, 3); assert.equal(h.audios[0].paused, true); assert.equal(h.audios[0].src, ''); assert.equal(h.revoked.length, 1);
  const broken = await harness(t, { badMetadata: true }); await assert.rejects(broken.api.prepareMusicFile(file()), /无法播放/);
  assert.equal(broken.revoked.length, 1);
});

test('音乐通过一个音量节点分别进入录制总线和监听；调音量不会重复接入音轨', async t => {
  const h = await harness(t), music = await h.create(); await music.start();
  assert.equal(music.snapshot().playing, true); assert.equal(h.connections.filter(edge => edge[0] === 'gain').length, 2);
  assert.equal(h.connections.filter(edge => edge[0] === 'source').length, 1);
  await music.control('volume', .85); await music.control('loop', false);
  assert.equal(music.snapshot().volume, .85); assert.equal(h.audios[0].loop, false);
  assert.equal(h.connections.filter(edge => edge[0] === 'gain').length, 2);
  music.close(); music.close(); assert.equal(h.revoked.length, 1); assert.equal(h.audios[0].paused, true);
});

test('录制暂停和恢复保持人工暂停意图；从头播放重新定位且结束后不再恢复', async t => {
  const h = await harness(t), music = await h.create(); await music.start();
  music.setRecordingPaused(true); assert.equal(h.audios[0].paused, true);
  music.setRecordingPaused(false); await tick(); assert.equal(h.audios[0].paused, false);
  await music.control('pause'); music.setRecordingPaused(true); music.setRecordingPaused(false); await tick();
  assert.equal(h.audios[0].paused, true);
  h.audios[0].currentTime = 2; await music.control('restart'); assert.equal(h.audios[0].currentTime, 0);
  music.close(); music.setRecordingPaused(false); await tick(); assert.equal(h.audios[0].paused, true);
});

test('取消等待中的元数据和迟到的音乐文件，均不遗留媒体元素或URL', async t => {
  const h = await harness(t, { pendingMetadata: true }); const pending = h.create(); await tick();
  h.signal.abort(new DOMException('cancelled', 'AbortError')); await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(h.revoked.length, 1); assert.equal(h.audios[0].src, '');
  const read = deferred(), late = await harness(t, { read: () => read.promise }); const starting = late.create();
  late.signal.abort(new DOMException('cancelled', 'AbortError')); read.resolve(file()); await assert.rejects(starting, { name: 'AbortError' });
  assert.equal(late.urls.length, 0);
});

test('播放请求晚于停止返回时不重新播放；非法控制值被拒绝', async t => {
  const gate = deferred(), h = await harness(t, { playGate: gate }), music = await h.create();
  const starting = music.start(); music.close(); gate.resolve(); await starting;
  assert.equal(h.audios[0].paused, true); assert.equal(h.revoked.length, 1);
  const live = await harness(t), player = await live.create();
  await assert.rejects(player.control('volume', -1), /音量无效/); await assert.rejects(player.control('loop', 'false'), /循环设置无效/);
  await assert.rejects(player.control('unknown'), /不支持/); player.close();
});

test('快速暂停继续时旧播放拒绝不取消新的音乐意图，关闭后的拒绝不发布过期错误', async t => {
  const old = deferred(), options = { playGate: old }, h = await harness(t, options), music = await h.create();
  const starting = music.start(); music.setRecordingPaused(true);
  options.playGate = null; music.setRecordingPaused(false); await tick();
  old.reject(new DOMException('旧播放被暂停', 'AbortError')); await starting;
  assert.equal(music.snapshot().playing, true);
  music.setRecordingPaused(true); music.setRecordingPaused(false); await tick();
  assert.equal(music.snapshot().playing, true, '没有被旧拒绝改为手动暂停');
  const late = deferred(); options.playGate = late;
  music.setRecordingPaused(true); music.setRecordingPaused(false); music.close();
  const changes = h.changes.length; late.reject(new DOMException('已关闭', 'AbortError')); await tick();
  assert.equal(h.changes.length, changes); assert.equal(h.audios[0].paused, true);
});
