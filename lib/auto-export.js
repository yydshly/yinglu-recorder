import { cleanupExportTemporaryFiles } from './export.js';
const ACTIVE = new Set(['preparing', 'downloading']);
const TERMINAL = new Set(['complete', 'error']);

export class AutoExporter {
  constructor({ chrome, updateRecord = async () => {}, onUpdate = () => {}, canPrepare = async () => true, onRelease = async () => {}, now = () => Date.now(), heartbeatTimeoutMs = 120000, progressTimeoutMs = 300000, convertingTimeoutMs = 900000, metadataTimeoutMs = 1500, storageTimeoutMs = 1500 }) {
    this.chrome = chrome; this.updateRecord = updateRecord; this.onUpdate = onUpdate;
    this.jobs = []; this.loaded = false; this.serial = Promise.resolve();
    this.now = now; this.heartbeatTimeoutMs = heartbeatTimeoutMs; this.progressTimeoutMs = progressTimeoutMs; this.convertingTimeoutMs = convertingTimeoutMs;
    this.canPrepare = canPrepare; this.onRelease = onRelease;
    this.metadataWrites = new Map(); this.metadataTimeoutMs = Math.max(0, metadataTimeoutMs);
    this.mirrorWrites = new Map(); this.storageTimeoutMs = Math.max(0, storageTimeoutMs);
  }
  run(task) {
    const result = this.serial.then(async () => { await this.load(); return task(); });
    this.serial = result.catch(() => {});
    return result;
  }
  async load() {
    if (this.loaded) return;
    const runtime = (await this.chrome.storage.session.get('autoExportJobs')).autoExportJobs;
    const durable = typeof this.chrome.storage.local?.get === 'function' ? (await this.chrome.storage.local.get('autoExportJobs')).autoExportJobs : [];
    const merged = new Map();
    for (const job of Array.isArray(durable) ? durable : []) if (job && typeof job.recordingId === 'string') merged.set(job.recordingId, { ...job });
    for (const job of Array.isArray(runtime) ? runtime : []) {
      if (!job || typeof job.recordingId !== 'string') continue;
      const prior = merged.get(job.recordingId);
      const runtimeNewer = !prior || (job.revision || 0) > (prior.revision || 0) || (job.revision || 0) === (prior.revision || 0) && (job.updatedAt || 0) >= (prior.updatedAt || 0);
      if (runtimeNewer) merged.set(job.recordingId, { ...job });
      else merged.set(job.recordingId, prior.token === job.token ? { ...job, ...prior, tabId: job.tabId, resourceUrl: job.resourceUrl } : { ...prior });
    }
    this.jobs = [...merged.values()];
    this.loaded = true;
  }
  info(job) {
    return { status: job.status, downloadId: job.downloadId, filename: job.filename,
      error: job.error || null, storage: job.storage, format: job.format || 'original', source: job.source, phase: job.phase,
      bytes: job.bytes, total: job.total, seconds: job.seconds, percent: job.percent, cleanupPending: !!job.cleanupPending };
  }
  async persist() {
    // Each mirror has one writer. A timed-out write may still finish later;
    // submit only the newest pending snapshot after it, never a concurrent one.
    const snapshots = {
      local: this.jobs.map(({ tabId, resourceUrl, ...summary }) => structuredClone(summary)),
      session: structuredClone(this.jobs)
    };
    const results = await Promise.all(Object.entries(snapshots).map(async ([area, jobs]) => {
      if (typeof this.chrome.storage[area]?.set !== 'function') return area === 'local';
      let writer = this.mirrorWrites.get(area);
      if (!writer) { writer = { running: false, blocked: false }; this.mirrorWrites.set(area, writer); }
      writer.pending = { autoExportJobs: jobs };
      if (!writer.running) {
        writer.running = true;
        writer.done = (async () => {
          let saved = false;
          try {
            while (writer.pending) {
              const value = writer.pending; writer.pending = null;
              try { await this.chrome.storage[area].set(value); saved = true; }
              catch { saved = false; }
              writer.blocked = false;
            }
            return saved;
          } finally { writer.running = false; }
        })();
      }
      if (writer.blocked) return false;
      let timer;
      try {
        return await Promise.race([writer.done, new Promise(resolve => { timer = setTimeout(() => { writer.blocked = true; resolve(false); }, this.storageTimeoutMs); })]);
      } finally { clearTimeout(timer); }
    }));
    return results.every(Boolean);
  }
  async publish(job, patch = {}) {
    Object.assign(job, patch, { updatedAt: this.now(), revision: (job.revision || 0) + 1 });
    if (TERMINAL.has(job.status) && !Object.hasOwn(patch, 'cleanupPending') &&
        (Number.isInteger(job.tabId) || job.resourceUrl || job.temporaryNames?.length)) job.cleanupPending = true;
    const persisted = await this.persist();
    const exported = this.info(job);
    // IDB bookkeeping cannot hold the control queue hostage. Keep a separate,
    // coalescing writer per recording: a late old transaction must finish before
    // the newest snapshot is submitted, so it can never overwrite that snapshot.
    const writer = this.writeMetadata(job.recordingId, exported);
    if (!writer.blocked) {
      let timer;
      try {
        await Promise.race([writer.done, new Promise(resolve => { timer = setTimeout(() => { writer.blocked = true; resolve(); }, this.metadataTimeoutMs); })]);
      } finally { clearTimeout(timer); }
    }
    try { await this.onUpdate({ recordingId: job.recordingId, export: exported }); } catch { /* UI updates are best effort. */ }
    return persisted;
  }
  writeMetadata(recordingId, exported) {
    let writer = this.metadataWrites.get(recordingId);
    if (!writer) { writer = { running: false, blocked: false }; this.metadataWrites.set(recordingId, writer); }
    writer.pending = { export: { ...exported } };
    if (!writer.running) {
      writer.running = true;
      writer.done = (async () => {
        try {
          while (writer.pending) {
            const patch = writer.pending; writer.pending = null;
            try { await this.updateRecord(recordingId, patch); } catch { /* IDB failure does not prevent cleanup or the newest pending update. */ }
            writer.blocked = false;
          }
        } finally { writer.running = false; }
      })();
    }
    return writer;
  }
  queueRecording(recordingId, { format = 'original' } = {}) {
    return this.run(async () => {
      if (typeof recordingId !== 'string' || !recordingId || recordingId.length > 300) throw new Error('无效的录制编号');
      if (!['original', 'mp4'].includes(format)) throw new Error('不支持的导出格式');
      let job = this.jobs.find(item => item.recordingId === recordingId);
      if (!job) {
        job = { recordingId, token: crypto.randomUUID(), status: 'queued', source: 'manual', format, createdAt: this.now() };
        this.jobs.push(job); await this.publish(job);
      }
      await this.pump(); return { ok: true, export: this.info(job) };
    });
  }
  retry(recordingId, { format } = {}) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === recordingId);
      format ||= job?.format || 'original';
      if (!['original', 'mp4'].includes(format)) throw new Error('不支持的导出格式');
      if (!job) {
        if (typeof recordingId !== 'string' || !recordingId || recordingId.length > 300) throw new Error('无效的录制编号');
        const fresh = { recordingId, token: crypto.randomUUID(), status: 'queued', source: 'manual', format, createdAt: this.now() };
        this.jobs.push(fresh); await this.publish(fresh); await this.pump();
        return { ok: true, export: this.info(fresh) };
      }
      if ((ACTIVE.has(job.status) || job.status === 'queued') && job.source === 'manual') return { ok: true, export: this.info(job) };
      if (Number.isInteger(job.downloadId) && job.status === 'downloading') return { ok: true, export: this.info(job) };
      if (!TERMINAL.has(job.status)) await this.publish(job, { status: 'error', error: '已暂停旧版待导出任务，请重新选择导出。' });
      if (!await this.finishPage(job)) return { ok: false, error: '上次自动保存页面尚未关闭，请先关闭该页面，再重试。', export: this.info(job) };
      await this.publish(job, { token: crypto.randomUUID(), status: 'queued', source: 'manual', format, tabId: undefined,
        downloadId: undefined, resourceUrl: undefined, filename: undefined, storage: undefined, error: null,
        bytes: 0, total: undefined, seconds: undefined, percent: undefined, phase: undefined, temporaryNames: [], heartbeatAt: undefined, progressAt: undefined, cleanupPending: false, documentId: undefined });
      await this.pump(); return { ok: true, export: this.info(job) };
    });
  }
  jobUrl(job) {
    return this.chrome.runtime.getURL(`exporter.html?id=${encodeURIComponent(job.recordingId)}&token=${encodeURIComponent(job.token)}&format=${encodeURIComponent(job.format || 'original')}`);
  }
  ownsUrl(url, job) {
    try {
      const actual = new URL(url), expected = new URL(this.chrome.runtime.getURL('exporter.html'));
      return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname &&
        actual.searchParams.get('id') === job.recordingId && actual.searchParams.get('token') === job.token;
    } catch { return false; }
  }
  async tab(job) {
    if (!Number.isInteger(job.tabId)) return;
    try { const tab = await this.chrome.tabs.get(job.tabId); if (this.ownsUrl(tab.url, job)) return tab; } catch { /* Closed tab. */ }
  }
  async authenticated(message, sender, job) {
    if (!job || sender?.id !== this.chrome.runtime.id || message.token !== job.token || !this.ownsUrl(sender.url, job)) return false;
    const tabId = sender.tab?.id ?? message.tabId;
    if (!Number.isInteger(tabId) || tabId !== job.tabId || (message.tabId !== undefined && message.tabId !== tabId)) return false;
    if (job.documentId && sender.documentId && job.documentId !== sender.documentId) return false;
    if (!await this.tab(job)) return false;
    if (!job.documentId && sender.documentId) { job.documentId = sender.documentId; await this.persist(); }
    return true;
  }
  async documentAlive(job) {
    if (!job.documentId) return false;
    if (typeof this.chrome.runtime.getContexts !== 'function') return undefined;
    let timer;
    try {
      const contexts = await Promise.race([
        this.chrome.runtime.getContexts({ contextTypes: ['TAB'], documentIds: [job.documentId], ...(Number.isInteger(job.tabId) ? { tabIds: [job.tabId] } : {}) }),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 2000); })
      ]);
      if (!Array.isArray(contexts)) return undefined;
      return contexts.some(context => context.documentId === job.documentId);
    } catch { return undefined; }
    finally { clearTimeout(timer); }
  }
  safeReady(message, job) {
    const prefix = `blob:${this.chrome.runtime.getURL('')}`;
    return typeof message.url === 'string' && message.url.startsWith(prefix) && message.url.length < 2000 &&
      typeof message.filename === 'string' && message.filename.length <= 200 && /\.(?:webm|mp4)$/i.test(message.filename) &&
      (job?.format !== 'mp4' || /\.mp4$/i.test(message.filename)) &&
      !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(message.filename) && !/[. ]$/.test(message.filename) &&
      message.filename !== '.' && message.filename !== '..' && ['opfs', 'blob'].includes(message.storage);
  }
  async pump() {
    if (this.jobs.some(job => ACTIVE.has(job.status) || job.cleanupPending)) return;
    for (const job of this.jobs.filter(item => item.status === 'queued')) {
      if (job.source !== 'manual') {
        await this.publish(job, { status: 'error', error: '旧版待导出任务已暂停。原始录制仍保留，请自行选择重试导出。' });
        await this.finishPage(job); continue;
      }
      if (typeof this.chrome.downloads?.download !== 'function') {
        await this.publish(job, { status: 'error', error: '未获得浏览器下载权限，请重新加载扩展后重试自动保存。' });
        continue;
      }
      try { if (!await this.canPrepare(job)) { this.scheduleCheck(); continue; } }
      catch (error) { await this.publish(job, { status: 'error', error: `无法准备自动保存：${error.message}` }); await this.finishPage(job); continue; }
      try {
        if (!await this.publish(job, { status: 'preparing', phase: 'preparing', error: null, heartbeatAt: this.now(), progressAt: this.now(), bytes: 0 })) {
          throw new Error('无法保存导出任务状态，请稍后重试；原始录制仍保留');
        }
        const tab = await this.chrome.tabs.create({ url: this.jobUrl(job), active: false });
        if (!Number.isInteger(tab?.id)) throw new Error('浏览器未能打开自动保存页面');
        if (!await this.publish(job, { tabId: tab.id })) throw new Error('无法保存导出页面状态，请稍后重试；原始录制仍保留');
        this.scheduleCheck(); return;
      } catch (error) { await this.publish(job, { status: 'error', error: `自动保存准备失败：${error.message}` }); await this.finishPage(job); }
    }
  }
  handleReady(message, sender) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === message.recordingId);
      if (!await this.authenticated(message, sender, job) || !this.safeReady(message, job)) return { ok: false, error: '无效的自动保存来源或文件信息' };
      if (job.status === 'downloading' || job.status === 'complete') return { ok: true, downloadId: job.downloadId };
      if (job.status !== 'preparing') return { ok: false, error: '自动保存任务已结束' };
      if (job.source !== 'manual') {
        await this.fail(job, '旧版待导出任务已暂停。原始录制仍保留，请自行选择重试导出。');
        return { ok: false, error: job.error };
      }
      try {
        // Save the URL before starting the download. If the worker exits before
        // receiving its ID, restore can find this exact browser download.
        if (!await this.publish(job, { resourceUrl: message.url, filename: `映录/${message.filename}`, storage: message.storage })) {
          throw new Error('无法保存导出任务状态，请稍后重试；原始录制仍保留');
        }
        const downloadId = await this.chrome.downloads.download({ url: message.url, filename: job.filename, saveAs: false, conflictAction: 'uniquify' });
        if (!Number.isInteger(downloadId)) throw new Error('浏览器没有返回下载任务编号');
        await this.publish(job, { status: 'downloading', downloadId });
        // A tiny local file can finish before onChanged listeners observe the
        // returned ID. The search also closes that race after service restarts.
        try {
          const [item] = await this.chrome.downloads.search({ id: downloadId });
          if (item) await this.reconcile(job, item);
        } catch { /* onChanged will report subsequent progress. */ }
        return { ok: true, downloadId };
      } catch (error) {
        await this.fail(job, `自动保存失败：${error.message}`);
        return { ok: false, error: job.error };
      }
    });
  }
  handleError(message, sender) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === message.recordingId);
      if (!await this.authenticated(message, sender, job)) return { ok: false, error: '无效的自动保存来源' };
      if (job.status === 'preparing') await this.fail(job, `自动保存失败：${String(message.error || '文件准备失败').slice(0, 1000)}`);
      return { ok: true };
    });
  }
  handleProgress(message, sender) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === message.recordingId);
      if (!await this.authenticated(message, sender, job)) return { ok: false, error: '无效的自动保存来源' };
      if (job.status !== 'preparing') return { ok: true, ignored: true };
      const phase = ['preparing', 'committing', 'converting', 'ready'].includes(message.phase) ? message.phase : job.phase;
      const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
      const bytes = finite(message.bytes) ? message.bytes : job.bytes || 0;
      const seconds = finite(message.seconds) ? message.seconds : job.seconds;
      const advanced = phase !== job.phase || bytes > (job.bytes || 0) || seconds > (job.seconds || 0);
      const names = new Set(job.temporaryNames || []);
      if (typeof message.temporaryName === 'string' && /^(?:auto-(?:\d+-)?[a-zA-Z0-9-]+|convert-[a-zA-Z0-9-]+)\.(?:webm|mp4)$/.test(message.temporaryName) &&
          (message.temporaryName.includes(`-${job.token}.`) || message.temporaryName.includes(`-${job.token}-source.`))) names.add(message.temporaryName);
      const persisted = await this.publish(job, { phase, bytes, seconds, total: finite(message.total) ? message.total : phase !== job.phase ? undefined : job.total,
        percent: finite(message.percent) ? Math.min(100, message.percent) : phase !== job.phase ? undefined : job.percent,
        storage: ['opfs', 'blob'].includes(message.storage) ? message.storage : job.storage,
        temporaryNames: [...names], heartbeatAt: this.now(), progressAt: advanced ? this.now() : job.progressAt });
      if (!persisted) { await this.fail(job, '无法保存导出进度，已停止本次导出；原始录制仍保留，可重试。'); return { ok: false, error: job.error }; }
      await this.checkStalledNow(); this.scheduleCheck(); return { ok: true };
    });
  }
  scheduleCheck() {
    if (this.checkTimer || !this.jobs.some(job => job.status === 'preparing' || job.status === 'queued' || job.cleanupPending)) return;
    this.checkTimer = setTimeout(() => { this.checkTimer = null; this.checkStalled().catch(() => {}); }, 15000);
    this.checkTimer.unref?.();
  }
  checkStalled() { return this.run(async () => {
    for (const job of this.jobs.filter(job => job.cleanupPending)) await this.finishPage(job);
    await this.checkStalledNow(); await this.pump(); this.scheduleCheck();
  }); }
  async checkStalledNow() {
    for (const job of this.jobs.filter(item => item.status === 'preparing')) {
      const lost = this.now() - (job.heartbeatAt ?? job.updatedAt ?? job.createdAt) > this.heartbeatTimeoutMs;
      const stalled = this.now() - (job.progressAt ?? job.createdAt) > (job.phase === 'converting' ? this.convertingTimeoutMs : this.progressTimeoutMs);
      if (lost || stalled) await this.fail(job, lost ? '自动保存页面长时间未响应，原始录制仍保留，可重试。' : '自动保存长时间没有新进度，已停止等待；原始录制仍保留，可重试。');
    }
  }
  cancel(recordingId) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === recordingId);
      if (!job) return { ok: true };
      if (TERMINAL.has(job.status)) {
        if (job.cleanupPending || Number.isInteger(job.tabId)) await this.finishPage(job);
        return { ok: true, export: this.info(job) };
      }
      if (Number.isInteger(job.downloadId)) await this.chrome.downloads?.cancel?.(job.downloadId).catch(() => {});
      await this.fail(job, '已取消自动保存，原始录制仍保留，可手动下载或重试。');
      return { ok: true, export: this.info(job) };
    });
  }
  tabUpdated(tabId, change = {}, tab = {}) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.tabId === tabId && (ACTIVE.has(item.status) || TERMINAL.has(item.status) && item.cleanupPending));
      if (!job) return;
      const moved = typeof (change.url || tab.url) === 'string' && !this.ownsUrl(change.url || tab.url, job);
      const discarded = change.discarded === true || tab.discarded === true;
      const reloaded = change.status === 'loading' && (job.resourceUrl || job.temporaryNames?.length);
      if (!moved && !discarded && !reloaded) return;
      if (TERMINAL.has(job.status)) { await this.finishPage(job); await this.sweep(); await this.pump(); this.scheduleCheck(); return; }
      if (Number.isInteger(job.downloadId)) await this.chrome.downloads?.cancel?.(job.downloadId).catch(() => {});
      await this.fail(job, '自动保存页面已跳转、重新加载或暂停，原始录制仍保留，可重试。');
    });
  }
  getState(recordingId) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.recordingId === recordingId);
      return { ok: true, export: job && this.info(job), states: recordingId ? undefined : this.jobs.map(job => ({ recordingId: job.recordingId, export: this.info(job) })) };
    });
  }
  recover(recordingId, previousExport) {
    return this.run(async () => {
      let job = this.jobs.find(item => item.recordingId === recordingId);
      if (!job && recordingId && previousExport?.status) {
        job = { ...previousExport, recordingId, token: crypto.randomUUID(), createdAt: this.now(), format: previousExport.format || 'original' };
        this.jobs.push(job);
        if (job.status === 'queued' && job.source === 'manual') await this.publish(job);
        else if (['queued', 'preparing', 'downloading'].includes(job.status)) {
          let item;
          if (Number.isInteger(job.downloadId)) {
            try { [item] = await this.chrome.downloads?.search?.({ id: job.downloadId }) || []; } catch { /* No session record can safely own a new export. */ }
          }
          if (item?.state === 'complete' && (!item.byExtensionId || item.byExtensionId === this.chrome.runtime.id)) await this.publish(job, { status: 'complete', filename: item.filename || job.filename, error: null });
          else if (item?.state === 'in_progress' && item.byExtensionId === this.chrome.runtime.id) await this.publish(job, { status: 'downloading', downloadId: item.id, error: null });
          else {
            await this.publish(job, { status: 'error', error: '先前的自动保存会话已结束，原始录制仍保留，可重试自动保存。' });
          }
        } else await this.publish(job);
      }
      await this.restoreNow(); return { ok: true, export: job && this.info(job) };
    });
  }
  async sweep() {
    return cleanupExportTemporaryFiles({ activeTokens: this.jobs.filter(job => ACTIVE.has(job.status) || job.cleanupPending || Number.isInteger(job.tabId)).map(job => job.token),
      finishedTokens: this.jobs.filter(job => TERMINAL.has(job.status) && !job.cleanupPending && !Number.isInteger(job.tabId)).map(job => job.token), now: this.now() }).catch(() => ({ removed: [], errors: [] }));
  }
  async finishPage(job) {
    const owner = { ...job };
    if (!Number.isInteger(job.tabId) && job.temporaryNames?.length && typeof this.chrome.tabs.query === 'function') {
      try {
        const existing = (await this.chrome.tabs.query({})).find(tab => this.ownsUrl(tab.url, owner));
        if (existing) { owner.tabId = existing.id; if (job.token === owner.token) job.tabId = existing.id; }
      } catch { /* A closed page is handled below. */ }
    }
    if (!await this.tab(owner)) {
      if (job.token !== owner.token) return false;
      if (await this.documentAlive(owner) !== false) {
        await this.publish(job, { cleanupPending: true, cleanupError: '仍在等待旧转换页面结束，暂时保留转换占用。' });
        this.scheduleCheck(); return false;
      }
      if (TERMINAL.has(job.status) && (job.tabId !== undefined || job.resourceUrl !== undefined || job.cleanupPending)) {
        await this.publish(job, { tabId: undefined, resourceUrl: undefined, cleanupPending: false });
      }
      await this.onRelease(owner);
      return true;
    }
    let timer, response;
    try {
      response = await Promise.race([
        this.chrome.runtime.sendMessage({ target: 'exporter', type: 'EXPORT_FINISH', recordingId: owner.recordingId, token: owner.token }),
        new Promise(resolve => { timer = setTimeout(resolve, 30000); })
      ]);
      if (response?.ok === false && job.token === owner.token) job.cleanupError = response.error || '临时文件清理未完成';
    } catch { /* A closed page has already released its object URL. */ }
    finally { clearTimeout(timer); }
    if (response?.pending && job.token === owner.token) {
      await this.publish(job, { cleanupPending: true, cleanupError: response.error || '正在结束本机文件读写。' });
      this.scheduleCheck(); return false;
    }
    // Never close a tab the user has navigated elsewhere during cleanup.
    if (await this.tab(owner)) await this.chrome.tabs.remove(owner.tabId).catch(() => {});
    if (job.token !== owner.token) return false;
    if (await this.tab(owner)) {
      await this.publish(job, { cleanupPending: true, cleanupError: '自动保存页面尚未关闭，暂时保留转换占用。' });
      this.scheduleCheck(); return false;
    }
    if (await this.documentAlive(owner) !== false) {
      await this.publish(job, { cleanupPending: true, cleanupError: '仍在等待旧转换页面结束，暂时保留转换占用。' });
      this.scheduleCheck(); return false;
    }
    if (response?.ok) { job.temporaryNames = []; job.cleanupError = undefined; }
    if (TERMINAL.has(job.status)) await this.publish(job, { tabId: undefined, resourceUrl: undefined, cleanupPending: false });
    await this.onRelease(owner);
    return true;
  }
  async fail(job, error) {
    await this.publish(job, { status: 'error', error });
    await this.finishPage(job); await this.sweep(); await this.pump();
  }
  async reconcile(job, item) {
    if (!ACTIVE.has(job.status)) return;
    if (item.state === 'complete') {
      await this.publish(job, { status: 'complete', filename: item.filename || job.filename, error: null });
      await this.finishPage(job); await this.pump();
    } else if (item.state === 'interrupted') await this.fail(job, `自动保存中断：${item.error || '浏览器取消了下载'}。录制库副本仍保留，可重试。`);
  }
  changed(delta) {
    return this.run(async () => {
      const job = this.jobs.find(item => item.downloadId === delta.id && item.status === 'downloading');
      if (!job) return;
      await this.reconcile(job, { state: delta.state?.current, error: delta.error?.current, filename: delta.filename?.current });
    });
  }
  tabRemoved(tabId) {
    const ownerToken = this.jobs.find(item => item.tabId === tabId)?.token;
    return this.run(async () => {
      const job = this.jobs.find(item => item.tabId === tabId && (ACTIVE.has(item.status) || TERMINAL.has(item.status)));
      if (!job || ownerToken && job.token !== ownerToken) return;
      if (TERMINAL.has(job.status)) {
        await this.finishPage(job); await this.sweep(); await this.pump(); return;
      }
      if (Number.isInteger(job.downloadId)) {
        try {
          const [item] = await this.chrome.downloads.search({ id: job.downloadId });
          if (item?.state === 'complete' || item?.state === 'interrupted') { await this.reconcile(job, item); return; }
          await this.chrome.downloads.cancel?.(job.downloadId);
        } catch { /* The saved IDB video remains available. */ }
      }
      await this.fail(job, '自动保存页面已关闭，录制库副本仍保留，可手动下载或重试。');
    });
  }
  restore() { return this.run(() => this.restoreNow()); }
  async restoreNow() {
      for (const job of this.jobs) {
        if (TERMINAL.has(job.status)) { await this.finishPage(job); continue; }
        const legacyPending = job.source !== 'manual' && ['queued', 'preparing'].includes(job.status);
        if (!ACTIVE.has(job.status) && !legacyPending) continue;
        // tabs.create can succeed immediately before a worker exits and before
        // its returned tab ID reaches session storage. Reuse that exact token
        // URL instead of opening a second page or leaving the first orphaned.
        if (!Number.isInteger(job.tabId) && typeof this.chrome.tabs.query === 'function') {
          try {
            const existing = (await this.chrome.tabs.query({})).find(tab => this.ownsUrl(tab.url, job));
            if (existing) await this.publish(job, { tabId: existing.id });
          } catch { /* Missing IDs are treated as disconnected below. */ }
        }
        if (typeof this.chrome.downloads?.search !== 'function') {
          await this.publish(job, { status: 'error', error: '未获得浏览器下载权限，请重新加载扩展后重试自动保存。' });
          await this.finishPage(job); continue;
        }
        let item;
        try {
          if (Number.isInteger(job.downloadId)) [item] = await this.chrome.downloads.search({ id: job.downloadId });
          else if (job.resourceUrl) {
            const matches = await this.chrome.downloads.search({ url: job.resourceUrl });
            item = matches.find(match => !match.byExtensionId || match.byExtensionId === this.chrome.runtime.id);
          }
        } catch {
          // A transient browser API failure is not evidence that a download
          // vanished. Keep this active job for a later event or restore.
          continue;
        }
        if (item) {
          await this.publish(job, { status: 'downloading', downloadId: item.id });
          await this.reconcile(job, item);
          // The browser already owns this download. A missing old exporter
          // page is not permission to cancel an actual user-visible download.
          continue;
        } else if (legacyPending) {
          await this.publish(job, { status: 'error', error: '旧版待导出任务已暂停。原始录制仍保留，请自行选择重试导出。' });
          await this.finishPage(job); continue;
        } else if (Number.isInteger(job.downloadId) || job.resourceUrl) {
          await this.publish(job, { status: 'error', error: '自动保存任务已断开，录制库副本仍保留，可重试。' });
          await this.finishPage(job); continue;
        }
        if (!await this.tab(job)) {
          if (Number.isInteger(job.downloadId)) await this.chrome.downloads.cancel?.(job.downloadId).catch(() => {});
          await this.publish(job, { status: 'error', error: '自动保存页面已关闭，录制库副本仍保留，可重试。' });
          await this.finishPage(job);
        }
      }
      await this.sweep(); await this.checkStalledNow(); await this.pump(); this.scheduleCheck(); return { ok: true };
  }
}
