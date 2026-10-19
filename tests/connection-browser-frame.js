// Test-only browser boundary. Production background/panel modules are imported
// unchanged below; no real Chrome permission or capture API is invoked here.
const listeners = [], available = new Set(), injections = [], intervals = new Map(), activated = new Set(), updated = new Set();
const tabs = new Map([[7, { id: 7, title: '骑行演示 A', url: 'https://a.example/' }],
  [8, { id: 8, title: '性能参数示例 B', url: 'https://b.example/' }], [9, { id: 9, title: '连接超时示例 C', url: 'https://c.example/' }],
  [10, { id: 10, status: 'loading', pendingUrl: 'https://loading.example/' }],
  [11, { id: 11, title: '加载恢复示例', url: 'https://retry.example/', status: 'loading' }],
  [12, { id: 12, title: '切回自动恢复示例', url: 'https://revisit.example/', status: 'complete' }]]);
let active = 7, granted = false;
// Include a pre-upgrade permission failure, matching the user's first-use screenshot.
const store = { targetTab: { id: 7, windowId: 1 }, connection: { status: 'error', tabId: 7,
  error: 'Chrome 尚未授权这个网页', detail: '[inject] Cannot access contents of the page' } }, prefix = 'chrome-extension://connection-fixture/';
const api = window.connectionFixture = { injections, intervals, requests: 0, mediaStarts: 0, stall: false, ready: false,
  dropTabNotifications: false, droppedNotifications: 0, failOnce: new Set(), allowPermission: false,
  active: () => active, activate(id, notify = true) { active = id; if (notify) for (const fn of activated) fn({ windowId: 1, tabId: id }); },
  async update(id, change) {
    Object.assign(tabs.get(id), change);
    if (change.url || change.status === 'loading') available.delete(id);
    await Promise.all([...updated].map(fn => fn(id, change, { ...tabs.get(id), windowId: 1, active: active === id })));
  },
  refresh() { chrome.runtime.sendMessage({ target: 'panel', type: 'REFRESH', windowId: 1 }); } };
const set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
window.setInterval = (fn, ms) => { const id = set(fn, ms); intervals.set(id, ms); return id; };
window.clearInterval = id => { intervals.delete(id); clear(id); };
globalThis.chrome = {
  runtime: { id: 'connection-fixture', getURL: path => prefix + path, getManifest: () => ({ version: '0.6.3' }), getContexts: async () => [],
    onMessage: { addListener: fn => listeners.push(fn) },
    sendMessage: msg => new Promise(resolve => {
      if (api.dropTabNotifications && msg.target === 'panel' && ['tab-activated', 'tab-updated'].includes(msg.reason)) {
        api.droppedNotifications++; resolve({ ok: true }); return;
      }
      let async = false;
      for (const fn of listeners) if (fn(msg, { id: 'connection-fixture', url: prefix + 'panel.html' }, resolve) === true) async = true;
      if (!async) resolve({ ok: true });
    }) },
  action: { onClicked: { addListener() {} }, setBadgeText() {}, setBadgeBackgroundColor() {} }, sidePanel: { open: async () => {} },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: { contains: async () => granted, request: async () => { api.requests++; if (api.allowPermission) granted = true; return api.allowPermission; } },
  storage: { session: { get: async () => structuredClone(store), set: async patch => Object.assign(store, structuredClone(patch)) },
    local: { get: async () => ({}), set: async () => {} } },
  tabs: { query: async () => [{ ...(granted ? tabs.get(active) : { id: active }), windowId: 1, active: true }], get: async id => ({ ...(granted ? tabs.get(id) : { id }), windowId: 1, active: active === id }),
    sendMessage: async id => available.has(id) ? { ok: true, width: 1200, height: 800 } : undefined,
    onUpdated: { addListener: fn => updated.add(fn), removeListener: fn => updated.delete(fn) },
    onActivated: { addListener: fn => activated.add(fn), removeListener: fn => activated.delete(fn) }, onRemoved: { addListener() {} } },
  scripting: { executeScript: async options => {
    const id = options.target.tabId; injections.push(id);
    if (!granted) throw new Error('Cannot access contents of the page. Extension manifest must request permission');
    if (api.stall) return new Promise(() => {});
    if (api.failOnce.delete(id)) throw new Error('Frame was removed during navigation');
    available.add(id); return [{ frameId: 0, result: { ok: true } }];
  } },
  offscreen: { createDocument: async () => { api.mediaStarts++; }, closeDocument: async () => {} },
  tabCapture: { getMediaStreamId: async () => { api.mediaStarts++; throw new Error('本检查不启用媒体采集'); } }
};
await import('../background.js');
await import('../panel.js');
api.ready = true;
