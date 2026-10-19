// Real production background/offscreen/panel modules, with Chrome acquisition
// replaced by a generated canvas stream. No native capture or microphone.
const listeners = [], prefix = 'chrome-extension://music-fixture/', store = {}, local = {};
let exists = false;
const api = window.musicFixture = { ready: false, lastState: { status: 'idle' }, acquired: [], contexts: [], players: [], encodedAudioTracks: [] };
api.databaseOpens = []; api.musicFileReads = 0; api.materialListReads = 0;
const nativeOpen = indexedDB.open.bind(indexedDB);
indexedDB.open = (name, ...args) => { api.databaseOpens.push(name); return nativeOpen(name, ...args); };
const nativeGet = IDBObjectStore.prototype.get, nativeAll = IDBObjectStore.prototype.getAll;
IDBObjectStore.prototype.get = function(...args) { if(this.transaction.db.name==='yinglu-music' && this.name==='files') api.musicFileReads++; return nativeGet.apply(this,args); };
IDBObjectStore.prototype.getAll = function(...args) { if(this.transaction.db.name==='yinglu-image-materials') api.materialListReads++; return nativeAll.apply(this,args); };
const createElement = document.createElement.bind(document);
document.createElement = function(tag, ...args) { const element = createElement(tag, ...args); if (tag === 'audio') api.players.push(element); return element; };
const NativeContext = window.AudioContext, NativeRecorder = window.MediaRecorder;
window.AudioContext = class extends NativeContext { constructor(...args) { super(...args); api.contexts.push(this); } };
window.MediaRecorder = class extends NativeRecorder { constructor(stream, options) { super(stream, options); api.encodedAudioTracks.push(stream.getAudioTracks().length); } };
const getUserMedia = navigator.mediaDevices.getUserMedia;
navigator.mediaDevices.getUserMedia = async constraints => {
  if (!constraints.video) throw new Error('本检查不请求麦克风');
  const canvas = createElement('canvas'); canvas.width = 320; canvas.height = 180;
  const ctx = canvas.getContext('2d'); let frame = 0;
  const draw = () => { ctx.fillStyle = frame++ % 2 ? '#315b49' : '#4b8064'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = 'white'; ctx.font = '20px system-ui'; ctx.fillText('音乐独立混音测试', 44, 85); ctx.fillText(String(frame), 145, 125); };
  draw(); const stream = canvas.captureStream(20), timer = setInterval(draw, 50);
  const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
  track.stop = () => { clearInterval(timer); stop(); };
  api.acquired.push(stream); return stream;
};
globalThis.chrome = {
  runtime: { id: 'music-fixture', getURL: path => prefix + path, getManifest: () => ({ version: '0.6.9' }),
    getContexts: async filter => filter?.contextTypes?.includes('OFFSCREEN_DOCUMENT') && exists ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [],
    onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: message => new Promise(resolve => {
      let async = false;
      if (message.target === 'background' && message.type === 'STATE') api.lastState = structuredClone(message.state);
      if (message.target === 'offscreen' && message.type === 'START') api.startOptions = structuredClone(message.options);
      const sender = { id: 'music-fixture', url: prefix + (message.type === 'STATE' ? 'offscreen.html' : 'panel.html') };
      for (const fn of listeners) if (fn(message, sender, resolve) === true) async = true;
      if (!async) resolve({ ok: true });
    }) },
  windows: { getCurrent: async () => ({ id: 1 }) },
  action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }, sidePanel: { open: async () => {} },
  permissions: { contains: async () => true },
  storage: { session: { get: async () => structuredClone(store), set: async patch => Object.assign(store, structuredClone(patch)) },
    local: { get: async () => structuredClone(local), set: async patch => Object.assign(local, structuredClone(patch)) } },
  tabs: { query: async () => [{ id: 7, windowId: 1, title: '合成画面与本机音乐', url: 'https://example.test/' }],
    get: async () => ({ id: 7, windowId: 1, title: '合成画面与本机音乐', url: 'https://example.test/' }),
    sendMessage: async () => ({ ok: true, width: 1200, height: 800 }), onUpdated: { addListener() {} }, onActivated: { addListener() {} }, onRemoved: { addListener() {} } },
  scripting: { executeScript: async () => [{ frameId: 0, result: { ok: true } }] },
  offscreen: { createDocument: async options => { exists = true; api.reasons = options.reasons; }, closeDocument: async () => { exists = false; } },
  tabCapture: { getMediaStreamId: async () => 'synthetic-canvas' }
};
window.addEventListener('pagehide', () => {
  for (const stream of api.acquired) stream.getTracks().forEach(track => track.stop());
  for (const context of api.contexts) context.close().catch(() => {});
  navigator.mediaDevices.getUserMedia = getUserMedia;
});
await import('../background.js'); await import('../offscreen.js'); await import('../panel.js'); api.ready = true;
