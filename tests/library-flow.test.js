import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionForMime, isRecordingFormatSupported } from '../lib/media-format.js';
const source = (await readFile(new URL('../library.js', import.meta.url), 'utf8')).replace(/^import \{ bounded \}.*;\r?\n/m, `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n`);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, { detail = false, recordData = {}, mp4Supported = true, exportState, active = [] } = {}) {
  const elements = new Map(), created = [], calls = [], messages = [], removed = [], listeners = [], storageListeners = [], events = {}, urls = new Map(), revoked = [];
  class Element {
    constructor(id) { this.id = id; this.children = []; this.hidden = true; this.handlers = {}; }
    setAttribute() {} addEventListener(type,fn) { (this.handlers[type] ||= []).push(fn); } pause() { this.paused = true; } load() { this.loaded = true; }
    removeAttribute(name) { delete this[name]; }
    append(...children) { for(const c of children) { if(typeof c==='object') c.parent=this; this.children.push(c); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get lastElementChild() { return this.children.at(-1); }
    insertBefore(child,before) { child.remove(); const at=before?this.children.indexOf(before):this.children.length; this.children.splice(at,0,child); child.parent=this; }
    remove() { if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this); this.parent=null; }
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const record = { id: 'r1', title: '录制', createdAt: Date.now(), bytes: 129 * 1024 * 1024, width: 1920, height: 1080, fps: 30, duration: 1000, status: 'complete', ...recordData };
  const h = { channels: [], channelMessages: [], get, calls, messages, created, removed, urls, revoked, events, record, recordReads: 0, listReads: 0, active, exportIds: [], readLocks: new Map(), intervals: [], blobReads: 0, fileWrites: 0, closed: 0 };
  h.notify = async message => { listeners.forEach(listener => listener(message)); await tick(); };
  h.storageChange = async (changes, area = 'session') => { storageListeners.forEach(listener => listener(changes, area)); await tick(); };
  t.mock.method(URL, 'createObjectURL', blob => { const url = `blob:test-${urls.size + 1}`; urls.set(url, blob); return url; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const values = {
    document: { hidden: false, addEventListener: (type,fn)=>(events[type] ||= []).push(fn), getElementById: get, createElement: tag => { const e = new Element(tag); created.push(e); return e; } },
    BroadcastChannel: class { constructor(name){this.name=name;h.channels.push(this);} postMessage(data){h.channelMessages.push(data);} close(){this.closed=true;} },
    location: { search: detail ? '?id=r1' : '', href: '' },
    confirm: () => true,
    chrome: { storage: { onChanged: { addListener: listener => storageListeners.push(listener) } }, tabs: { getCurrent: async () => ({ id: 99 }) }, runtime: { id: 'test', onMessage: { addListener: listener => listeners.push(listener) }, sendMessage: async message => {
      calls.push(message.type); messages.push(message);
      if (h.respond) return h.respond(message);
      if (h.connectionError) return { ok: false };
      if (message.type === 'GET_EXPORT_STATE') return { ok: true, export: exportState || h.record.export };
      if (message.type === 'MEDIA_READ_ACQUIRE') { h.readLocks.set(message.token, message.recordingId); return { ok: true }; }
      if (message.type === 'MEDIA_READ_RELEASE') { h.readLocks.delete(message.token); return { ok: true }; }
      if (message.type === 'MEDIA_READ_RENEW' && h.renewError) return { ok: false, error: h.renewError };
      if (message.type === 'DELETE_RECORDING') {
        if (h.active.includes(message.recordingId) || h.exportIds.includes(message.recordingId) || [...h.readLocks.values()].includes(message.recordingId)) return { ok: false, error: '视频仍在录制、自动导出或被读取' };
        removed.push(message.recordingId); return { ok: true };
      }
      return { ok: true, ids: h.active, exportIds: h.exportIds, mediaActivity: h.activity };
    } } },
    navigator: { storage: { estimate: async () => ({ quota: 1024 ** 3, usage: 2 * 1024 ** 2 }) } },
    showSaveFilePicker: async options => { calls.push('picker'); h.pickerOptions = options; return { createWritable: async () => ({ write: async () => {h.nativeWrites=(h.nativeWrites||0)+1;if(h.nativeWriteGate)await h.nativeWriteGate;}, close: async () => { if (h.closeGate) await h.closeGate; h.closed++; }, abort: async () => {h.aborts=(h.aborts||0)+1;} }) }; },
    MediaRecorder: { isTypeSupported: mime => !mime.startsWith('video/mp4') || mp4Supported },
    addEventListener: (name, listener) => (events[name] ||= []).push(listener),
    setInterval: callback => { h.intervals.push(callback); return h.intervals.length; }, clearInterval() {},
    libraryTest: { extensionForMime, isRecordingFormatSupported, PREVIEW_BLOB_LIMIT: 32 * 1024 * 1024,
      cleanupPreviewFiles: async () => { h.previewSweeps = (h.previewSweeps || 0) + 1; },
      prepareRecordingPreview: async (id, options) => {
        h.signal = options.signal;
        if (h.readGate) await h.readGate;
        if (!h.ignorePreviewAbort) options.signal.throwIfAborted();
        if (h.previewError) throw h.previewError;
        const small = h.record.bytes <= 32 * 1024 * 1024;
        const blob = small ? await values.libraryTest.recordingBlob(id, options) : new Blob(['file-backed preview']);
        if (!small) h.stagedReads = (h.stagedReads || 0) + 1;
        const url = URL.createObjectURL(blob); let cleaned = false;
        return { url, storage: small ? 'blob' : 'opfs', cleanup: async () => {
          if (cleaned) return; cleaned = true; h.previewCleanups = (h.previewCleanups || 0) + 1; URL.revokeObjectURL(url);
        } };
      },
      listRecordingPage: async ({limit,before,signal}) => { h.listReads++; (h.pageRequests ||= []).push({limit,before}); const records = h.records || [h.record]; if (h.listGate) await h.listGate; signal?.throwIfAborted(); if(h.listError) throw h.listError; const offset = before ? records.findIndex(r=>r.id===before[1])+1 : 0; const page=records.slice(offset,offset+limit), more=offset+limit<records.length; return {records:page,hasMore:more,next:more?[page.at(-1).createdAt,page.at(-1).id]:null}; }, getRecording: async () => { h.recordReads++; return h.record; },
      recordingBlob: async (id, options) => { h.blobReads++; h.signal = options.signal; if (h.readGate) await h.readGate; options.signal.throwIfAborted(); return new Blob(['video']); },
      writeRecordingTo: async (id, writable, options) => { h.fileWrites++; h.signal = options.signal; if(h.writeOverride) return h.writeOverride(writable,options); if (h.readGate) await h.readGate; options.signal.throwIfAborted(); if (h.writeError) throw h.writeError; }, deleteRecording: async id => { h.localDelete = true; removed.push(id); }, clockText: () => '00:01', fileSize: bytes => String(bytes) }
  };
  const descriptors = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(async () => {
    events.pagehide?.forEach(listener => listener()); await tick();
    for (const [key, descriptor] of Object.entries(descriptors)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
  });
  const code = 'const { prepareRecordingPreview, cleanupPreviewFiles, PREVIEW_BLOB_LIMIT, extensionForMime, isRecordingFormatSupported, listRecordingPage, getRecording, writeRecordingTo, deleteRecording, clockText, fileSize } = globalThis.libraryTest;\n' + `import { bounded } from '${new URL('../lib/async.js', import.meta.url).href}';\n` + `import { createFileResource } from '${new URL('../lib/file-resource.js', import.meta.url).href}';\n` + source.replace(/^import .*;\r?\n/gm, '') + '\n//' + Math.random();
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')); await tick();
  return h;
}

test('大视频不会自动载入完整 Blob，直接保存调用分段写文件入口', async t => {
  const h = await harness(t, { detail: true });
  assert.equal(h.blobReads, 0); assert.equal(h.get('load-preview').hidden, false);
  h.calls.length = 0; await h.get('export-file').onclick();
  assert.equal(h.calls[0], 'picker'); assert.equal(h.calls[1], 'GET_ACTIVE_RECORDINGS');
  assert.equal(h.fileWrites, 1); assert.equal(h.closed, 1); assert.equal(h.blobReads, 0);
});

test('录制库每页20条，载入更多仅取下一页，重复点击不叠加任务', async t => {
  const h = await harness(t);
  h.records=Array.from({length:65},(_,i)=>({...h.record,id:`r${i}`,title:`视频${i}`}));
  h.events.focus.forEach(fn=>fn()); await tick(); await tick();
  assert.equal(h.get('list').children.length,20); assert.equal(h.get('load-more').hidden,false);
  const first=h.get('list').children[0], reads=h.listReads;
  let release; h.listGate=new Promise(resolve=>{release=resolve;});
  const load=h.get('load-more').onclick(); await tick();
  const duplicate=h.get('load-more').onclick(); assert.equal(h.listReads,reads+1);
  release(); await Promise.all([load,duplicate]); h.listGate=null;
  assert.equal(h.get('list').children.length,40); assert.equal(h.get('list').children[0],first);
  assert.deepEqual(h.pageRequests.at(-1).before,[h.record.createdAt,'r19']);
  await h.get('load-more').onclick(); await h.get('load-more').onclick();
  assert.equal(h.get('list').children.length,65); assert.equal(h.get('load-more').hidden,true);
  assert.match(h.get('list-status').textContent,/65.*全部/); assert.equal(h.blobReads,0);
});

test('分页读取失败保留已显示卡片，可重试；刷新保留已展开范围并移除已删除项', async t => {
  const h=await harness(t); h.records=Array.from({length:43},(_,i)=>({...h.record,id:`r${i}`}));
  h.events.focus.forEach(fn=>fn()); await tick(); await tick();
  const first=h.get('list').children[0]; h.listError=new Error('本地读取超时');
  await h.get('load-more').onclick(); assert.equal(h.get('list').children.length,20);
  assert.equal(h.get('retry-list').hidden,false); assert.equal(h.get('load-more').disabled,false);
  h.listError=null; await h.get('load-more').onclick(); assert.equal(h.get('list').children.length,40);
  h.records.splice(1,1); h.events.focus.forEach(fn=>fn()); await tick(); await tick();
  assert.equal(h.get('list').children.length,40); assert.equal(h.get('list').children[0],first);
  assert.equal(h.get('retry-list').hidden,true);
  assert.equal(h.get('list').children[1].children[1].textContent,h.records[1].title);
});

test('载入更多期间有新录制通知，丢弃旧页后按已展开范围重查且不重复', async t => {
  const h=await harness(t); h.records=Array.from({length:45},(_,i)=>({...h.record,id:`r${i}`}));
  h.events.focus.forEach(fn=>fn()); await tick(); await tick();
  let release; h.listGate=new Promise(resolve=>{release=resolve;}); const load=h.get('load-more').onclick(); await tick();
  h.records=[{...h.record,id:'new'},...h.records];
  await h.notify({type:'STATE',state:{id:'new',sessionId:'new',status:'complete'}});
  release(); await load; h.listGate=null;
  assert.equal(h.get('list').children.length,40);
  const links=h.get('list').children.map(c=>c.children[4].children[0].href);
  assert.equal(new Set(links).size,40); assert.ok(links[0].endsWith('=new'));
});

test('隐藏取消查询后立刻切回，旧查询结束时自动补查而不留在读取中', async t => {
  const h=await harness(t); let release;
  h.listGate=new Promise(resolve=>{release=resolve;}); h.events.focus.forEach(fn=>fn()); await tick();
  document.hidden=true; h.events.visibilitychange.forEach(fn=>fn());
  document.hidden=false; h.events.visibilitychange.forEach(fn=>fn());
  const reads=h.listReads; release(); h.listGate=null; await tick(); await tick();
  assert.equal(h.listReads,reads+1); assert.equal(h.get('load-more').disabled,false);
  assert.match(h.get('list-status').textContent,/已显示/);
});

test('删除前重新查询活动录制，不能凭页面打开时的旧状态删除', async t => {
  const h = await harness(t); h.active = ['r1'];
  await h.created.find(element => element.textContent === '删除').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /仍在录制/);
  assert.equal(h.calls.every(type => ['GET_ACTIVE_RECORDINGS', 'GET_EXPORT_STATE'].includes(type)), true);
});

test('确认删除后再次核对状态，避免确认期间录制状态发生变化', async t => {
  const h = await harness(t);
  globalThis.confirm = () => { h.active = ['r1']; return true; };
  await h.created.find(element => element.textContent === '删除').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /仍在录制/);
});

test('录制控制连接失败时禁止删除', async t => {
  const h = await harness(t); h.connectionError = true;
  await h.created.find(element => element.textContent === '删除').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /无法确认录制状态/);
});

test('旧录制缺少诊断时明确显示未采集，不自动创建诊断下载', async t => {
  const h = await harness(t, { detail: true });
  assert.match(h.get('performance-summary').textContent, /视频路径：未采集/);
  assert.match(h.get('page-performance-summary').textContent, /录制前：未采集/);
  assert.match(h.get('page-performance-summary').textContent, /停止后：未采集/);
  assert.equal(h.urls.size, 0); assert.equal(h.get('retry-export').hidden, true);
});

test('诊断区区分轨道设置和页面节拍，显示 Canvas、写入队列与各阶段样本', async t => {
  const sample = (meanMs, intervalCount = 10) => ({ visibility: 'visible', enoughData: true,
    raf: { meanMs, intervalCount }, longTasks: { supported: true, count: 1, totalMs: 70 }, webglContextLost: 0 });
  const h = await harness(t, { detail: true, recordData: {
    performance: { video: { pipeline: 'canvas', requestedFrameRate: 30, sourceSettings: { frameRateSetting: 120 }, outputSettings: { width: 1280 }, canvas: { drawnFrames: 20, drawSubmitMsTotal: 100, drawSubmitMsMax: 10 } },
      audio: { mode: 'mixed' }, storage: { chunkWriteMsMax: 90, peakPendingBytes: 1024, peakPendingChunks: 2, chunkWritesFailed: 0 } },
    pageDiagnostics: { samples: [{ phase: 'baseline', sample: sample(10) }, { phase: 'recording', sample: sample(20) }, { phase: 'recording', sample: { visibility: 'hidden', raf: null, longTasks: { supported: false }, webglContextLost: 1 } }, { phase: 'recovery', sample: sample(10) }] }
  } });
  assert.match(h.get('performance-summary').textContent, /frameRateSetting.*120/);
  assert.match(h.get('performance-summary').textContent, /20 次；平均 5.0 ms；最长 10.0 ms/);
  assert.match(h.get('performance-summary').textContent, /最长 90.0 ms；峰值待写 1024 \/ 2 段/);
  assert.match(h.get('performance-summary').textContent, /音频路径：混合音轨/);
  assert.match(h.get('page-performance-summary').textContent, /录制中：可见页 RAF 节拍 50.0 次\/秒/);
  assert.match(h.get('page-performance-summary').textContent, /WebGL 上下文丢失 1 次；含 1 段非可见/);
  const html = await readFile(new URL('../library.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="performance-diagnostics">/);
  assert.match(html, /不是实测 FPS/); assert.match(html, /不是 WebGL 帧率/);
  assert.match(html, /嵌入作品请独立打开后录制/);
});

test('诊断 JSON 只在手动点击时生成，重复下载和离页释放对象 URL', async t => {
  const h = await harness(t, { detail: true, recordData: { performance: { audio: { mode: 'none' } } } });
  const link = h.get('download-diagnostics');
  assert.equal(h.urls.size, 0);
  link.onclick(); const first = link.href;
  const data = JSON.parse(await h.urls.get(first).text());
  assert.equal(data.recording.id, 'r1'); assert.equal(data.performance.audio.mode, 'none');
  assert.equal(data.pageDiagnostics, null); assert.match(link.download, /\.json$/);
  link.onclick(); assert.deepEqual(h.revoked, [first]);
  h.events.pagehide.forEach(listener => listener());
  assert.deepEqual(h.revoked, [first, link.href]);
  assert.equal(h.calls.every(type => ['GET_ACTIVE_RECORDINGS', 'GET_EXPORT_STATE'].includes(type)), true);
});

test('PERF_UPDATED 仅重读诊断详情，EXPORT_STATE 动态更新且不重载视频', async t => {
  const h = await harness(t, { detail: true, recordData: { bytes: 20, export: { status: 'queued' } } });
  const player = h.get('player'), src = player.src; player.currentTime = 17;
  assert.equal(h.blobReads, 1); assert.equal(h.recordReads, 1);
  h.record = { ...h.record, pageDiagnostics: { samples: [{ phase: 'recovery', sample: { visibility: 'visible', enoughData: false, raf: { meanMs: 25, intervalCount: 2 } } }] } };
  await h.notify({ type: 'PERF_UPDATED', id: 'other' }); assert.equal(h.recordReads, 1);
  await h.notify({ type: 'PERF_UPDATED', id: 'r1' }); assert.equal(h.recordReads, 2);
  assert.match(h.get('page-performance-summary').textContent, /停止后：可见页 RAF 节拍 40.0 次\/秒.*样本不足/);
  for (const [status, label] of [['preparing', '正在准备'], ['downloading', '正在下载'], ['complete', '导出完成'], ['error', '导出失败']]) {
    await h.notify({ type: 'EXPORT_STATE', recordingId: 'r1', export: { status, error: '磁盘空间不足' } });
    assert.match(h.get('auto-export-status').textContent, new RegExp(label));
  }
  await h.notify({ type: 'EXPORT_STATE', recordingId: 'other', export: { status: 'complete' } });
  assert.match(h.get('auto-export-status').textContent, /磁盘空间不足/);
  assert.equal(h.get('retry-export').hidden, false);
  assert.equal(h.blobReads, 1); assert.equal(player.src, src); assert.equal(player.currentTime, 17);
});

test('自动保存失败可重试，迟到的请求响应不会覆盖较新的下载状态', async t => {
  const h = await harness(t, { detail: true, recordData: { export: { status: 'error', error: '下载中断' } } });
  let completeRetry;
  h.respond = () => new Promise(resolve => { completeRetry = resolve; });
  const retry = h.get('retry-export').onclick();
  await tick();
  assert.equal(h.get('retry-export').disabled, true);
  assert.deepEqual(h.messages.at(-1), { target: 'background', type: 'RETRY_EXPORT', tabId: 99, recordingId: 'r1' });
  await h.notify({ type: 'EXPORT_STATE', recordingId: 'r1', export: { status: 'downloading' } });
  completeRetry({ ok: true, export: { status: 'queued' } }); await retry;
  assert.match(h.get('auto-export-status').textContent, /正在下载到本机/);
  assert.equal(h.get('retry-export').hidden, true); assert.equal(h.blobReads, 0);
});

test('重试失败保留错误与重试入口，不把失败显示为排队成功', async t => {
  const h = await harness(t, { detail: true, recordData: { export: { status: 'error' } } });
  h.respond = async () => ({ ok: false, error: '录制片段不存在' });
  await h.get('retry-export').onclick();
  assert.match(h.get('auto-export-status').textContent, /导出失败/);
  assert.match(h.get('error').textContent, /录制片段不存在/);
  assert.equal(h.get('retry-export').hidden, false); assert.equal(h.get('retry-export').disabled, false);
});

test('导出中的视频保护删除，但允许预览', async t => {
  const h = await harness(t, { detail: true }); h.exportIds = ['r1'];
  await h.get('delete').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /导出/);
  await h.get('load-preview').onclick();
  assert.equal(h.blobReads, 0); assert.equal(h.stagedReads, 1); assert.equal(h.get('player').hidden, false);
});

test('超过32MiB手动走文件预览，释放播放器和缓存后可再次载入', async t => {
  const h = await harness(t, { detail: true, recordData: { bytes: 33 * 1024 * 1024 } });
  assert.equal(h.stagedReads, undefined); assert.equal(h.get('load-preview').hidden, false);
  await h.get('load-preview').onclick();
  assert.equal(h.stagedReads, 1); assert.equal(h.blobReads, 0); assert.equal(h.readLocks.size, 0);
  const first = h.get('player').src; assert.equal(h.get('close-preview').hidden, false);
  await h.get('close-preview').onclick();
  assert.equal(h.get('player').src, undefined); assert.equal(h.get('player').hidden, true); assert.equal(h.get('player').paused, true);
  assert.equal(h.previewCleanups, 1); assert.ok(h.revoked.includes(first)); assert.equal(h.get('load-preview').hidden, false);
  await h.get('load-preview').onclick(); assert.equal(h.stagedReads, 2);
});

test('载入预览可以取消，结束读取后恢复入口并保持无错误，可再次尝试', async t => {
  const h = await harness(t, { detail: true }); let finish;
  h.readGate = new Promise(resolve => { finish = resolve; });
  const loading = h.get('load-preview').onclick(); await tick();
  assert.equal(h.get('close-preview').disabled, false); assert.equal(h.get('close-preview').textContent, '取消载入');
  await h.get('close-preview').onclick(); assert.equal(h.signal.aborted, true);
  finish(); await loading;
  assert.equal(h.readLocks.size, 0); assert.equal(h.urls.size, 0); assert.equal(h.get('error').hidden, true);
  assert.equal(h.get('load-preview').disabled, false); assert.equal(h.get('load-preview').hidden, false);
  h.readGate = null; await h.get('load-preview').onclick(); assert.equal(h.get('player').hidden, false);
});

test('页面关闭后迟到返回的文件资源也会被释放，不挂到已关闭的播放器', async t => {
  const h = await harness(t, { detail: true }); let finish;
  h.readGate = new Promise(resolve => { finish = resolve; }); h.ignorePreviewAbort = true;
  const loading = h.get('load-preview').onclick(); await tick();
  h.events.pagehide.forEach(listener => listener()); finish(); await loading;
  assert.equal(h.previewCleanups, 1); assert.equal(h.revoked.length, 1); assert.equal(h.get('player').src, undefined);
  assert.equal(h.readLocks.size, 0);
});

test('缓存准备失败保留重新载入和直接保存入口，不会调用大Blob回退', async t => {
  const h = await harness(t, { detail: true }); h.previewError = new Error('临时文件空间不足');
  await h.get('load-preview').onclick();
  assert.equal(h.get('load-preview').hidden, false); assert.equal(h.get('load-preview').disabled, false);
  assert.equal(h.get('export-file').disabled, false); assert.equal(h.blobReads, 0); assert.equal(h.readLocks.size, 0);
  assert.match(h.get('error').textContent, /空间不足/);
});

test('删除确认期间开始自动导出，会被第二次检查阻止', async t => {
  const h = await harness(t);
  globalThis.confirm = () => { h.exportIds = ['r1']; return true; };
  await h.created.find(element => element.textContent === '删除').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /自动导出/);
});

test('分段保存持有全局读取锁，确认后的删除由后台原子拒绝，完成后释放', async t => {
  const h = await harness(t, { detail: true });
  let finish; h.readGate = new Promise(resolve => { finish = resolve; });
  const saving = h.get('export-file').onclick(); await tick();
  const acquire = h.messages.find(message => message.type === 'MEDIA_READ_ACQUIRE');
  assert.equal(acquire.recordingId, 'r1'); assert.equal(acquire.tabId, 99); assert.ok(acquire.token);
  assert.equal(h.readLocks.size, 1);
  await h.get('delete').onclick();
  assert.equal(h.removed.length, 0); assert.match(h.get('error').textContent, /被读取/);
  assert.equal(h.localDelete, undefined);
  finish(); await saving;
  assert.equal(h.readLocks.size, 0);
  const release = h.messages.find(message => message.type === 'MEDIA_READ_RELEASE');
  assert.equal(release.token, acquire.token); assert.equal(h.closed, 1);
});

test('读取失败及页面关闭都会释放读取锁，关闭页面中止剩余读取', async t => {
  const h = await harness(t, { detail: true });
  h.writeError = new Error('磁盘写入失败'); await h.get('export-file').onclick();
  assert.equal(h.readLocks.size, 0); assert.match(h.get('error').textContent, /磁盘写入失败/);
  let finish; h.readGate = new Promise(resolve => { finish = resolve; });
  const preview = h.get('load-preview').onclick(); await tick();
  assert.equal(h.readLocks.size, 1);
  h.events.pagehide.forEach(listener => listener()); await tick();
  assert.equal(h.signal.aborted, true); assert.equal(h.readLocks.size, 0);
  finish(); await preview; assert.equal(h.urls.size, 0);
});

test('续约失败中止读取，最后关闭文件期间失败也不会显示保存成功', async t => {
  const h = await harness(t, { detail: true }); h.renewError = '读取锁已失效';
  let finish; h.readGate = new Promise(resolve => { finish = resolve; });
  const saving = h.get('export-file').onclick(); await tick();
  await h.intervals.at(-1)(); assert.equal(h.signal.aborted, true);
  finish(); await saving;
  assert.equal(h.closed, 0); assert.equal(h.readLocks.size, 0);
  assert.match(h.get('export-status').textContent, /保存未完成/);
  assert.match(h.get('error').textContent, /读取锁已失效/);

  h.readGate = null; h.closeGate = new Promise(resolve => { finish = resolve; });
  const closing = h.get('export-file').onclick(); await tick();
  await h.intervals.at(-1)(); assert.equal(h.signal.aborted, true);
  finish(); await closing;
  assert.equal(h.readLocks.size, 0);
  assert.match(h.get('export-status').textContent, /保存未完成/);
});

test('录制库详情初始化补查导出结果，列表收到消息会更新对应卡片', async t => {
  const h = await harness(t, { detail: true, recordData: { export: { status: 'queued' } }, exportState: { status: 'error', error: '下载被取消' } });
  assert.match(h.get('auto-export-status').textContent, /下载被取消/); assert.equal(h.get('retry-export').hidden, false);
});

test('录制库列表实时更新导出状态，不需要刷新整页', async t => {
  const h = await harness(t, { recordData: { export: { status: 'queued' } } });
  const status = h.created.find(element => element.textContent === '等待导出'); assert.ok(status);
  await h.notify({ type: 'EXPORT_STATE', recordingId: 'r1', export: { status: 'complete', format: 'mp4' } });
  assert.match(status.textContent, /导出完成.*MP4/);
});

test('网页录制结束后列表重读库数据并解锁删除，复用原卡片', async t => {
  const h = await harness(t, { active: ['r1'], recordData: { status: 'recording', bytes: 10 } });
  const card = h.get('list').children[0], tag = card.children[0], title = card.children[1], meta = card.children[2];
  const remove = h.created.find(element => element.textContent === '删除');
  assert.equal(tag.textContent, '正在录制'); assert.equal(remove.disabled, true);
  h.active = []; h.record = { ...h.record, status: 'complete', bytes: 300, title: '库中完整标题' };
  await h.notify({ target: 'panel', type: 'STATE', state: { id: 'r1', sessionId: 'web-1', status: 'complete', title: '不可信广播标题', bytes: 999 } });
  assert.equal(h.get('list').children[0], card); assert.equal(tag.textContent, '已完成');
  assert.equal(remove.disabled, false); assert.equal(title.textContent, '库中完整标题'); assert.match(meta.textContent, /300/);
  assert.equal(h.blobReads, 0);
});

test('桌面录制接受后的 session 变化与恢复通知更新列表，同状态进度不重复读取', async t => {
  const h = await harness(t, { active: ['r1'], recordData: { status: 'recording' } });
  const card = h.get('list').children[0], before = { id: 'r1', sessionId: 'desktop-1', status: 'recording', bytes: 10 };
  await h.storageChange({ desktopRecording: { oldValue: before, newValue: { ...before, bytes: 20 } } });
  assert.equal(h.listReads, 1);
  h.active = []; h.record = { ...h.record, status: 'complete' };
  const completed = { ...before, status: 'complete' };
  await h.storageChange({ desktopRecording: { oldValue: before, newValue: completed } });
  assert.equal(card.children[0].textContent, '已完成'); assert.equal(h.listReads, 2);
  await h.notify({ type: 'DESKTOP_RECOVERED', state: completed }); assert.equal(h.listReads, 2);
  await h.storageChange({ setting_format: { oldValue: 'webm', newValue: 'mp4' } }, 'local');
  assert.equal(h.listReads, 2);
  h.record = { ...h.record, status: 'interrupted' };
  await h.notify({ type: 'DESKTOP_RECOVERED', state: { ...completed, status: 'interrupted' } });
  assert.equal(card.children[0].textContent, '可尝试恢复');
  assert.equal(h.created.find(element => element.textContent === '删除').disabled, false);
});

test('乱序刷新不回写旧卡片数据，新增录制与焦点补漏只依据当前库内容', async t => {
  const h = await harness(t, { active: ['r1'], recordData: { status: 'recording', title: '旧标题' } });
  let release;
  h.listGate = new Promise(resolve => { release = resolve; });
  await h.notify({ type: 'STATE', state: { id: 'r1', sessionId: 'web-1', status: 'recording' } });
  h.active = []; h.record = { ...h.record, status: 'complete', title: '新标题' };
  await h.notify({ type: 'STATE', state: { id: 'r1', sessionId: 'web-1', status: 'complete' } });
  h.listGate = null; release(); await tick();
  const first = h.get('list').children[0];
  assert.equal(first.children[0].textContent, '已完成'); assert.equal(first.children[1].textContent, '新标题');
  const reads = h.listReads;
  await h.notify({ type: 'STATE', state: { id: 'r1', sessionId: 'web-1', status: 'complete', bytes: 999 } });
  assert.equal(h.listReads, reads);
  h.records = [{ ...h.record, id: 'r2', title: '另一次录制' }, h.record];
  h.events.focus.forEach(listener => listener()); await tick();
  assert.equal(h.get('list').children.length, 2); assert.equal(h.get('list').children[1], first);
  await h.notify({ type: 'STATE', state: { id: 'r1', sessionId: 'old-session', status: 'recording', title: '迟到' } });
  assert.equal(first.children[0].textContent, '已完成'); assert.equal(first.children[1].textContent, '新标题');
  assert.equal(h.get('list').children[0].children[1].textContent, '另一次录制');
});

test('详情页忽略列表更新信号，保持播放位置与预览 Blob', async t => {
  const h = await harness(t, { detail: true, recordData: { bytes: 20 } });
  const video = h.get('player'), src = video.src; video.currentTime = 17;
  const reads = h.recordReads;
  await h.notify({ type: 'STATE', state: { id: 'other', sessionId: 'web-1', status: 'complete' } });
  await h.notify({ type: 'DESKTOP_RECOVERED', state: { id: 'r1', sessionId: 'desktop-1', status: 'interrupted' } });
  await h.storageChange({ desktopRecording: { oldValue: { status: 'recording' }, newValue: { status: 'complete' } } });
  h.events.focus.forEach(listener => listener()); await tick();
  assert.equal(h.listReads, 0); assert.equal(h.recordReads, reads); assert.equal(h.blobReads, 1);
  assert.equal(video.src, src); assert.equal(video.currentTime, 17);
});

test('实际 MP4 原片使用 MP4 下载后缀和文件类型，不显示重复转换入口', async t => {
  const h = await harness(t, { detail: true, recordData: { mimeType: 'video/mp4;codecs=avc1' } });
  assert.match(h.get('download').download, /\.mp4$/); assert.equal(h.get('convert-mp4').hidden, true);
  await h.get('export-file').onclick();
  assert.match(h.pickerOptions.suggestedName, /\.mp4$/);
  assert.deepEqual(h.pickerOptions.types[0].accept, { 'video/mp4': ['.mp4'] });
});

test('WebM 转换通过后台 MP4 任务执行，展示进度和取消且保留原片下载格式', async t => {
  const h = await harness(t, { detail: true, recordData: { mimeType: 'video/webm' } });
  assert.equal(h.get('convert-mp4').hidden, false); assert.equal(h.get('convert-mp4').disabled, false);
  await h.get('convert-mp4').onclick();
  assert.equal(h.messages.find(message => message.type === 'RETRY_EXPORT').format, 'mp4');
  await h.notify({ type: 'EXPORT_STATE', recordingId: 'r1', export: { status: 'preparing', phase: 'converting', format: 'mp4', percent: 43 } });
  assert.match(h.get('auto-export-status').textContent, /本机转换.*43%/); assert.equal(h.get('cancel-export').hidden, false);
  await h.get('cancel-export').onclick();
  assert.equal(h.messages.at(-1).type, 'EXPORT_CANCEL'); assert.match(h.get('auto-export-status').textContent, /已取消/);
  assert.match(h.get('download').download, /\.webm$/);
});

test('预览等待读取租约时可取消，迟到授权会再次释放而不读视频', async t => {
  const h = await harness(t,{detail:true}); let acquired;
  h.respond = async message => {
    if(message.type==='MEDIA_READ_ACQUIRE') { await new Promise(resolve=>{acquired=resolve;}); h.readLocks.set(message.token,message.recordingId); }
    if(message.type==='MEDIA_READ_RELEASE') h.readLocks.delete(message.token);
    return {ok:true,ids:[]};
  };
  const pending = h.get('load-preview').onclick(); await tick();
  await h.get('close-preview').onclick(); await pending;
  assert.equal(h.get('load-preview').disabled,false); assert.equal(h.stagedReads,undefined);
  acquired(); await tick(); await tick(); assert.equal(h.readLocks.size,0); assert.equal(h.urls.size,0);
});
test('读取租约授权超时可重试，迟到授权不会留下租约', async t => {
  const h = await harness(t,{detail:true}); let acquired, timeout;
  const nativeTimeout = globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...rest)=> { if(ms===10000){timeout=fn;return 123;} return nativeTimeout(fn,ms,...rest); });
  h.respond = async message => {
    if(message.type==='MEDIA_READ_ACQUIRE') { await new Promise(resolve=>{acquired=resolve;}); h.readLocks.set(message.token,message.recordingId); }
    if(message.type==='MEDIA_READ_RELEASE') h.readLocks.delete(message.token);
    return {ok:true,ids:[]};
  };
  const pending=h.get('load-preview').onclick(); await tick(); timeout(); await pending;
  assert.match(h.get('error').textContent,/超时/); assert.equal(h.get('load-preview').disabled,false);
  acquired(); await tick(); await tick(); assert.equal(h.readLocks.size,0);
});

test('读取占用续约挂起时超时中断读取，恢复载入按钮且不挂载旧视频', async t => {
  const h=await harness(t,{detail:true});let finish,timeout;
  const nativeTimeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...rest)=>{if(ms===10000){timeout=fn;return 123;}return nativeTimeout(fn,ms,...rest);});
  h.readGate=new Promise(resolve=>{finish=resolve;});
  const loading=h.get('load-preview').onclick();await tick();
  h.respond=async message=>{
    if(message.type==='MEDIA_READ_RENEW')return new Promise(()=>{});
    if(message.type==='MEDIA_READ_RELEASE')h.readLocks.delete(message.token);
    return {ok:true,ids:[]};
  };
  const renewing=h.intervals.at(-1)();await tick();timeout();await renewing;
  assert.equal(h.signal.aborted,true);finish();await loading;
  assert.equal(h.get('load-preview').disabled,false);assert.equal(h.readLocks.size,0);assert.equal(h.urls.size,0);
  assert.match(h.get('error').textContent,/超时/);
});
test('释放读取占用无响应也有超时，已生成的预览不会永久停在加载中', async t=>{
  const h=await harness(t,{detail:true});let releaseTimeout;
  const nativeTimeout=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...rest)=>{if(ms===3000){releaseTimeout=fn;return 123;}return nativeTimeout(fn,ms,...rest);});
  h.respond=async message=>{
    if(message.type==='MEDIA_READ_RELEASE')return new Promise(()=>{});
    return {ok:true,ids:[]};
  };
  const loading=h.get('load-preview').onclick();await tick();releaseTimeout();await loading;
  assert.equal(h.get('player').hidden,false);assert.equal(h.get('load-preview').disabled,false);
});

test('预览读取完成后正在等待读取占用释放时，取消不继续等待释放响应',async t=>{
  const h=await harness(t,{detail:true});let finish;
  const gate=new Promise(resolve=>{finish=resolve;});
  h.respond=async message=>{if(message.type==='MEDIA_READ_RELEASE')await gate;return {ok:true,ids:[]};};
  const loading=h.get('load-preview').onclick();await tick();
  assert.equal(h.urls.size,1);await h.get('close-preview').onclick();await loading;
  assert.equal(h.previewCleanups,1);assert.equal(h.get('player').hidden,true);assert.equal(h.get('load-preview').disabled,false);
  finish();await tick();
});

test('开始其他录制后已载入回看释放，结束后恢复入口且不自动播放',async t=>{
  const h=await harness(t,{detail:true,recordData:{bytes:20}});h.get('player').currentTime=17;
  h.active=['another'];h.activity={web:true,desktop:false,reserved:true};
  await h.notify({type:'STATE',state:{id:'another',sessionId:'new',status:'preparing'}});
  assert.equal(h.previewCleanups,1);assert.equal(h.get('player').src,undefined);assert.equal(h.get('load-preview').disabled,true);
  assert.match(h.get('preview-note').textContent,/正在录制或转换/);
  h.active=[];h.activity={web:false,desktop:false,reserved:false};
  await h.notify({type:'STATE',state:{id:'another',sessionId:'new',status:'complete'}});
  assert.equal(h.get('load-preview').disabled,false);assert.equal(h.get('player').hidden,true);
  await h.get('load-preview').onclick();h.get('player').duration=100;h.get('player').handlers.loadedmetadata[0]();
  assert.equal(h.get('player').currentTime,17);
});
test('录制准备尚未有视频id时也从协调器识别占用，原生播放控件不能绕过',async t=>{
  const h=await harness(t,{detail:true,recordData:{bytes:20}});h.activity={web:true,desktop:false,reserved:true};
  await h.notify({type:'STATE',state:{sessionId:'starting',status:'preparing'}});
  assert.equal(h.get('load-preview').disabled,true);h.get('player').paused=false;h.get('player').handlers.play[0]();assert.equal(h.get('player').paused,true);
});
test('迟到旧录制消息只唤醒状态核查，不释放当前回看或锁住按钮',async t=>{
  const h=await harness(t,{detail:true,recordData:{bytes:20}}),src=h.get('player').src;
  h.activity={web:false,desktop:false,reserved:false};
  await h.notify({type:'STATE',state:{id:'old',sessionId:'old-session',status:'recording'}});
  assert.equal(h.get('player').src,src);assert.equal(h.previewCleanups,undefined);assert.equal(h.get('load-preview').disabled,false);
});
test('另一个录制库窗口开始使用预览时本页释放资源，离页关闭广播通道',async t=>{
  const h=await harness(t,{detail:true,recordData:{bytes:20}});h.channels[0].onmessage({data:{owner:'another-window'}});await tick();
  assert.equal(h.previewCleanups,1);assert.equal(h.get('player').hidden,true);
  h.events.pagehide.forEach(fn=>fn());assert.equal(h.channels[0].closed,true);
});
test('直接保存有取消入口，写入挂起时可返回；迟到写入结束前禁止叠加保存',async t=>{
  const h=await harness(t,{detail:true});let finish;
  h.nativeWriteGate=new Promise(resolve=>{finish=resolve;});t.after(async()=>{finish();await tick();});
  h.writeOverride=(writer)=>writer.write(new Blob(['chunk']));
  const saving=h.get('export-file').onclick();await tick();
  assert.equal(h.get('cancel-export').hidden,false);assert.equal(h.get('cancel-export').textContent,'取消保存');
  await h.get('cancel-export').onclick();await saving;
  assert.match(h.get('export-status').textContent,/已取消保存/);assert.equal(h.aborts,1);assert.equal(h.closed,0);assert.equal(h.get('export-file').disabled,false);
  const pickers=h.calls.filter(x=>x==='picker').length;await h.get('export-file').onclick();assert.equal(h.calls.filter(x=>x==='picker').length,pickers);
  finish();await tick();h.nativeWriteGate=null;await h.get('export-file').onclick();assert.equal(h.closed,1);
});
test('录制开始会取消正在写入的本地保存，不删除原始录制',async t=>{
  const h=await harness(t,{detail:true});let finish;
  h.nativeWriteGate=new Promise(resolve=>{finish=resolve;});t.after(async()=>{finish();await tick();});h.writeOverride=writer=>writer.write(new Blob(['chunk']));
  const saving=h.get('export-file').onclick();await tick();h.active=['new'];h.activity={web:true,desktop:false,reserved:true};
  await h.notify({type:'STATE',state:{id:'new',sessionId:'new',status:'recording'}});await saving;
  assert.equal(h.signal.aborted,true);assert.match(h.get('export-status').textContent,/已取消保存/);assert.equal(h.removed.length,0);assert.equal(h.get('load-preview').disabled,true);
  finish();await tick();
});
