(() => {
  if (globalThis.__yingluOverlay?.host?.isConnected) return { ok: true, reused: true };
  let host, messageListener;
  try {
  // Retrying a failed initialization must not be blocked by a stale boolean flag.
  document.querySelectorAll('yinglu-overlay').forEach(node => node.remove());
  const extension = !!globalThis.chrome?.runtime?.id;
  host = document.createElement('yinglu-overlay');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{color-scheme:light}svg{position:fixed;inset:0;width:100%;height:100%;overflow:visible;touch-action:none;user-select:none;pointer-events:none}
    .hint{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#172c25;color:white;padding:12px 20px;border-radius:10px;font:14px system-ui;box-shadow:0 4px 20px #0002;pointer-events:none}
    .editor,.annotation-text{box-sizing:border-box;padding:4px;border:1px solid transparent;font-family:system-ui,sans-serif;font-weight:600;line-height:1.25;white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;tab-size:4;letter-spacing:normal}
    .editor{position:fixed;min-width:60px;min-height:46px;max-width:100vw;max-height:90vh;border-style:dashed;border-color:#176951;background:#ffffffdd;outline:none;resize:both;pointer-events:auto;z-index:2}.annotation-text{width:100%;height:100%;pointer-events:none;overflow:hidden}.crop-cancel{margin-left:16px;padding:6px 12px;border:1px solid #ffffff88;border-radius:6px;background:#fff;color:#172c25;cursor:pointer;pointer-events:auto;font:14px system-ui}.click{position:fixed;width:32px;height:32px;border:3px solid #ffb347;border-radius:50%;transform:translate(-50%,-50%);animation:ripple .65s ease-out forwards;pointer-events:none}
    @keyframes ripple{to{opacity:0;transform:translate(-50%,-50%) scale(2)}}
  `;
  const canvas = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  canvas.setAttribute('aria-hidden', 'true');
  const hintElement = document.createElement('div');
  hintElement.className = 'hint'; hintElement.hidden = true;
  root.append(style, canvas, hintElement);
  document.documentElement.append(host);
  const svg = root.querySelector('svg');
  const viewWidth = () => !extension && document.getElementById('panel') ? document.getElementById('panel').getBoundingClientRect().left : innerWidth;
  if (!extension && document.getElementById('panel')) svg.style.width = `calc(100% - ${document.getElementById('panel').getBoundingClientRect().width}px)`;
  const hint = root.querySelector('.hint');
  const hintLabel = document.createElement('span');
  const cancelCrop = document.createElement('button'); cancelCrop.className = 'crop-cancel'; cancelCrop.textContent = '取消框选';
  hint.append(hintLabel, cancelCrop);
  const ns = 'http://www.w3.org/2000/svg';
  let options = { tool: 'pointer', color: '#f06445', width: 4, fontSize: 28, clicks: false };
  let shapes = [], history = [], future = [], selected = null, drag = null, cropMode = false;
  const limits = { shapes: 512, strokePoints: 4096, scenePoints: 64000, retainedPoints: 128000,
    historyEntries: 50, historyReferences: 12000, imageBytes: 64 * 1024 * 1024, storedImageBytes: 16 * 1024 * 1024 };
  let pendingMove = null;
  let archived = false, editor = null, editShape = null, frameRequest = 0, lastTextHit = null, selectionId = null, capturedPointer = null;
  let recordingViewport = null, viewportWait = null;
  const sameViewport = (area, width = viewWidth(), height = innerHeight) =>
    Math.abs(area.viewportWidth - width) <= 2 && Math.abs(area.viewportHeight - height) <= 2;
  function finishViewportWait(result) {
    if (!viewportWait) return;
    const waiting = viewportWait; viewportWait = null;
    clearTimeout(waiting.timer); waiting.reply(result);
  }
  function settleViewport(settings, reply) {
    if (!recordingViewport || recordingViewport.sessionId !== settings?.sessionId) {
      reply({ ok: false, error: '框选录制准备已结束，请重新开始。' }); return;
    }
    finishViewportWait({ ok: false, error: '网页尺寸确认已被新的请求替换。' });
    const waiting = viewportWait = { reply, width: viewWidth(), height: innerHeight,
      startedAt: probeNow(), changedAt: probeNow(), timer: null };
    const sample = () => {
      if (viewportWait !== waiting) return;
      const now = probeNow(), width = viewWidth(), height = innerHeight;
      if (width !== waiting.width || height !== waiting.height) Object.assign(waiting, { width, height, changedAt: now });
      if (now - waiting.startedAt >= 3000) return finishViewportWait({ ok: false, error: '网页尺寸仍在变化，请保持窗口稳定后重新录制。' });
      if (now - waiting.changedAt >= 300) return finishViewportWait({ ok: true, width, height });
      waiting.timer = setTimeout(sample, 100);
    };
    waiting.timer = setTimeout(sample, 100);
  }
  const shapeNodes = new Map();
  const imageAssets = new Map();
  let restoringImages, restoringEpoch, decodingImage = false;
  function decodeImage(blob) {
    if (decodingImage) return Promise.reject(new Error('图片仍在处理，请稍后重试。'));
    decodingImage = true;
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(new Error('图片载入超时，可再次点击显示上次标注。')); }, 10000);
      let pending;
      try { pending = createImageBitmap(blob); }
      catch (error) { decodingImage = false; clearTimeout(timer); reject(error); return; }
      Promise.resolve(pending).then(bitmap => {
        decodingImage = false; clearTimeout(timer);
        if (expired) bitmap.close(); else resolve(bitmap);
      }, error => { decodingImage = false; clearTimeout(timer); reject(error); });
    });
  }
  function releaseImagePixels() {
    for (const asset of imageAssets.values()) { asset.canvas.width = 0; asset.canvas.height = 0; }
  }
  async function ensureImagePixels(epoch, showArchived = false) {
    while (restoringImages) { await restoringImages; if (epoch !== annotationEpoch) return {ok:true, ignored:true}; }
    if (epoch !== annotationEpoch) return {ok:true, ignored:true};
    const task = restoreImagePixels(epoch, showArchived);
    restoringImages = task; restoringEpoch = epoch;
    try { return await task; } finally { if (restoringImages === task) restoringImages = null; }
  }
  async function restoreImagePixels(epoch, showArchived) {
    try {
      const needed = new Set(shapes.filter(s => s.type === 'image').map(s => s.assetId));
      for (const [id, asset] of imageAssets) {
        if (!needed.has(id) || asset.canvas.width) continue;
        const bitmap = await decodeImage(asset.blob);
        try {
          if (epoch !== annotationEpoch || !host.isConnected || !imageAssets.has(id)) return { ok: true, ignored: true };
          asset.canvas.width = asset.width; asset.canvas.height = asset.height;
          asset.canvas.getContext('2d').drawImage(bitmap, 0, 0);
        } finally { bitmap.close(); }
      }
      if (epoch !== annotationEpoch) return { ok: true, ignored: true };
      if (showArchived) { archived = false; options.tool = 'pointer'; }
      render();
      return { ok: true, count: shapes.length, tool: options.tool };
    } catch (error) { if (archived) releaseImagePixels(); return { ok: false, error: error.message }; }
  }
  let annotationEpoch = 0, annotationSession = null;
  const emit = (type, data = {}) => {
    if (extension) chrome.runtime.sendMessage({ target: 'background', type, ...data }).catch(() => {});
    else window.dispatchEvent(new CustomEvent('yinglu-demo-event', { detail: { type, ...data } }));
  };
  // This opt-in probe measures top-document scheduling, not WebGL render FPS
  // or encoded video FPS. It never replaces the site's animation callbacks.
  let performanceProbe = null, baselineSession = null, diagnosticsSession = null, recoveredSession = null;
  const probeNow = () => globalThis.performance?.now?.() ?? Date.now();
  const visibility = () => document.visibilityState || 'unknown';
  function stopPerformanceProbe(flush = false, reason = 'stopped') {
    const probe = performanceProbe;
    if (!probe) return;
    if (flush) emitPerformanceSample(probe, reason);
    performanceProbe = null;
    if (probe.frame) cancelAnimationFrame(probe.frame);
    clearTimeout(probe.timer);
    probe.observer?.disconnect();
    document.removeEventListener('visibilitychange', probe.visibilityChanged);
    document.removeEventListener('webglcontextlost', probe.contextLost, true);
  }
  function addLongTasks(probe, entries) {
    if (performanceProbe !== probe) return;
    for (const entry of entries) {
      if (!Number.isFinite(entry.duration) || entry.duration < 0 || entry.startTime < probe.windowStart) continue;
      probe.longTaskCount++; probe.longTaskMs += entry.duration;
      probe.longTaskMax = Math.max(probe.longTaskMax, entry.duration);
    }
  }
  function emitPerformanceSample(probe, reason) {
    if (performanceProbe !== probe) return;
    if (probe.observer) addLongTasks(probe, probe.observer.takeRecords());
    const end = probeNow(), durationMs = Math.max(0, end - probe.windowStart);
    const intervals = probe.intervals.slice().sort((a, b) => a - b);
    const meanMs = intervals.length ? probe.intervalSum / intervals.length : null;
    emit('PERF_SAMPLE', { sessionId: probe.sessionId, phase: probe.phase, sample: {
      scope: 'top-document', metric: 'raf-cadence', reason, durationMs,
      visibility: probe.visibility, visibleMs: probe.visibility === 'visible' ? durationMs : 0,
      enoughData: probe.visibility === 'visible' && durationMs >= 500 && intervals.length >= 10,
      raf: intervals.length && probe.visibility === 'visible' ? {
        intervalCount: intervals.length, meanMs, p95Ms: intervals[Math.ceil(intervals.length * .95) - 1],
        maxMs: intervals.at(-1), over50ms: probe.over50ms, cadenceHz: 1000 / meanMs
      } : null,
      longTasks: { supported: probe.longTasksSupported,
        count: probe.longTasksSupported ? probe.longTaskCount : null,
        totalMs: probe.longTasksSupported ? probe.longTaskMs : null,
        maxMs: probe.longTasksSupported ? probe.longTaskMax : null },
      webglContextLost: probe.contextLosses
    } });
    probe.windowStart = end; probe.intervals = []; probe.intervalSum = 0; probe.over50ms = 0;
    probe.lastFrame = null; probe.longTaskCount = 0; probe.longTaskMs = 0; probe.longTaskMax = 0; probe.contextLosses = 0;
  }
  function startPerformanceProbe(sessionId, phase) {
    if (!sessionId) return;
    if (performanceProbe?.sessionId === sessionId && performanceProbe.phase === phase) return;
    stopPerformanceProbe(true, 'phase-change');
    const probe = performanceProbe = { sessionId, phase, windowStart: probeNow(), visibility: visibility(),
      frame: 0, timer: 0, lastFrame: null, intervals: [], intervalSum: 0, over50ms: 0,
      longTasksSupported: false, longTaskCount: 0, longTaskMs: 0, longTaskMax: 0, contextLosses: 0 };
    const tick = timestamp => {
      if (performanceProbe !== probe) return;
      probe.frame = 0;
      if (probe.visibility !== 'visible') return;
      if (probe.lastFrame !== null) {
        const interval = timestamp - probe.lastFrame;
        // Bound memory if the browser delays the reporting timer. The sample
        // remains explicitly the observed callbacks, never an inferred FPS.
        if (interval > 0 && Number.isFinite(interval) && probe.intervals.length < 2048) {
          probe.intervals.push(interval); probe.intervalSum += interval;
          if (interval > 50) probe.over50ms++;
        }
      }
      probe.lastFrame = timestamp;
      probe.frame = requestAnimationFrame(tick);
    };
    probe.visibilityChanged = () => {
      if (performanceProbe !== probe) return;
      emitPerformanceSample(probe, 'visibility-change');
      probe.visibility = visibility();
      if (probe.frame) cancelAnimationFrame(probe.frame);
      probe.frame = probe.visibility === 'visible' ? requestAnimationFrame(tick) : 0;
    };
    probe.contextLost = () => { if (performanceProbe === probe) probe.contextLosses++; };
    document.addEventListener('visibilitychange', probe.visibilityChanged);
    document.addEventListener('webglcontextlost', probe.contextLost, true);
    const Observer = globalThis.PerformanceObserver;
    if (Observer?.supportedEntryTypes?.includes('longtask')) {
      try {
        probe.observer = new Observer(entries => addLongTasks(probe, entries.getEntries()));
        probe.observer.observe({ type: 'longtask', buffered: false });
        probe.longTasksSupported = true;
      } catch { probe.observer?.disconnect(); probe.observer = null; }
    }
    if (probe.visibility === 'visible') probe.frame = requestAnimationFrame(tick);
    const report = () => {
      if (performanceProbe !== probe) return;
      emitPerformanceSample(probe, 'interval');
      if (phase === 'recording') probe.timer = setTimeout(report, 2000);
      else { if (phase === 'recovery') recoveredSession = sessionId; stopPerformanceProbe(); }
    };
    probe.timer = setTimeout(report, phase === 'baseline' ? 1000 : 2000);
  }
  function beginDiagnostics(settings = {}) {
    if (!settings.diagnostics || !settings.sessionId) { stopPerformanceProbe(); return; }
    if (diagnosticsSession !== settings.sessionId) recoveredSession = null;
    diagnosticsSession = settings.sessionId;
    if (baselineSession !== settings.sessionId) {
      baselineSession = settings.sessionId;
      startPerformanceProbe(settings.sessionId, 'baseline');
      emitPerformanceSample(performanceProbe, 'not-measured-before-start');
      stopPerformanceProbe();
    }
    startPerformanceProbe(settings.sessionId, 'recording');
  }
  function endDiagnostics(settings = {}) {
    if (settings.sessionId && diagnosticsSession && settings.sessionId !== diagnosticsSession) return;
    if (settings.diagnostics && settings.sessionId && recoveredSession !== settings.sessionId) {
      startPerformanceProbe(settings.sessionId, 'recovery');
    } else stopPerformanceProbe(true, 'ended');
  }
  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    return n;
  };
  function pruneImageAssets() {
    const used = new Set([shapes, ...history, ...future].flatMap(items => items.filter(s => s.type === 'image').map(s => s.assetId)));
    for (const [id, asset] of imageAssets) if (!used.has(id)) {
      asset.canvas.remove(); asset.canvas.width = 0; asset.canvas.height = 0; imageAssets.delete(id);
    }
  }
  // Snapshots share unchanged shapes and point arrays. Existing shapes are
  // copied only when editing begins, never merely on selection.
  function annotationResources() {
    const arrays = new Set(); let retainedPoints = 0, references = 0;
    for (const scene of [shapes, ...history, ...future]) {
      references += scene.length;
      for (const shape of scene) if (shape.points && !arrays.has(shape.points)) {
        arrays.add(shape.points); retainedPoints += shape.points.length;
      }
    }
    return { shapes: shapes.length, scenePoints: shapes.reduce((sum, s) => sum + (s.points?.length || 0), 0),
      retainedPoints, references, undo: history.length, redo: future.length,
      imageBytes: [...imageAssets.values()].reduce((sum, a) => sum + a.canvas.width * a.canvas.height * 4, 0),
      reservedImageBytes: [...imageAssets.values()].reduce((sum, a) => sum + a.width * a.height * 4, 0),
      storedImageBytes: [...imageAssets.values()].reduce((sum, a) => sum + a.blob.size, 0), limits };
  }
  function trimHistory() {
    let resources = annotationResources();
    while (history.length + future.length && (history.length + future.length > limits.historyEntries ||
      resources.retainedPoints > limits.retainedPoints || resources.references > limits.historyReferences)) {
      if (history.length) history.shift(); else future.shift();
      resources = annotationResources();
    }
    pruneImageAssets();
  }
  const snap = () => { history.push(shapes.slice()); future = []; trimHistory(); };
  const editable = shape => {
    const copy = { ...shape }; shapes[shapes.indexOf(shape)] = copy; return copy;
  };
  function allowShape() {
    if (shapes.length < limits.shapes) return true;
    emit('ANNOTATION_ERROR', { error: '本页标注较多，请删除部分图形或清空后继续。' }); return false;
  }
  const changed = shape => { shape.revision = (shape.revision || 0) + 1; };
  const pointBounds = new WeakMap();
  function bounds(s) {
    if (s.type === 'image') return { x: s.x, y: s.y, width: s.boxWidth, height: s.boxHeight };
    if (s.type === 'text') { const size = s.fontSize || 28; return { x: s.x, y: s.y - size, width: s.boxWidth || 260, height: s.boxHeight || Math.max(46, s.text.split('\n').length * size * 1.25 + 10) }; }
    if (s.points && drag?.id === s.id && drag.matrix) return drag.visualBounds;
    const pts = s.points || [{ x: s.x, y: s.y }, { x: s.x2, y: s.y2 }];
    const cached = s.points && pointBounds.get(pts);
    const append = cached && cached.count <= pts.length && pts[cached.count - 1] === cached.last;
    let { left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity } = append ? cached : {};
    for (let i = append ? cached.count : 0; i < pts.length; i++) {
      const p = pts[i]; left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y);
    }
    if (s.points) pointBounds.set(pts, { left, top, right, bottom, count: pts.length, last: pts.at(-1) });
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  function updatePen(cached, s) {
    const path = cached.path, pts = s.points;
    const append = cached.points === pts && cached.pointCount <= pts.length && pts[cached.pointCount - 1] === cached.lastPoint;
    if (!append || cached.pointCount !== pts.length) {
      if (path.points?.appendItem && svg.createSVGPoint) {
        if (!append) path.points.clear();
        for (let i = append ? cached.pointCount : 0; i < pts.length; i++) {
          const p = svg.createSVGPoint(); p.x = pts[i].x; p.y = pts[i].y; path.points.appendItem(p);
        }
      } else path.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
    }
    cached.points = pts; cached.pointCount = pts.length; cached.lastPoint = pts.at(-1);
    const matrix = drag?.id === s.id ? drag.matrix : null;
    if (matrix) path.setAttribute('transform', `matrix(${matrix.join(' ')})`);
    else path.removeAttribute('transform');
    const b = bounds(s);
    for (const [key, value] of Object.entries({ x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 })) cached.hitArea.setAttribute(key, value);
    cached.node.setAttribute('stroke', s.color); cached.node.setAttribute('stroke-width', s.width);
    cached.shape = s; cached.revision = s.revision; cached.bounds = b;
  }
  function scheduleRender() { if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; flushMove(); render(); }); }
  function render() {
    if (frameRequest) { cancelAnimationFrame(frameRequest); frameRequest = 0; }
    const nodes = [], visibleIds = new Set();
    svg.style.pointerEvents = cropMode || options.tool !== 'pointer' ? 'auto' : 'none';
    svg.style.cursor = cropMode ? 'crosshair' : options.tool === 'select' ? 'move' : options.tool === 'pointer' ? 'auto' : 'crosshair';
    for (const s of archived ? [] : shapes) {
      if (s.id === editShape?.id) continue;
      visibleIds.add(s.id);
      const interactive = options.tool === 'select' || options.tool === 'text';
      const cached = shapeNodes.get(s.id);
      if (s.type === 'pen' && cached && (cached.shape !== s || cached.revision !== s.revision)) updatePen(cached, s);
      // An imported raster is painted only once. Moving/resizing changes its
      // DOM rectangle; it never decodes or repaints the bitmap in the draw loop.
      if (s.type === 'image' && cached && cached.revision !== s.revision) {
        const b = bounds(s);
        for (const [key, value] of Object.entries(b)) cached.imageBox.setAttribute(key, value);
        for (const [key, value] of Object.entries({ x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16 })) cached.hitArea.setAttribute(key, value);
        cached.shape = s; cached.revision = s.revision; cached.bounds = b;
      }
      const reusable = cached?.shape === s && cached.revision === s.revision;
      let group = cached?.node;
      const b = reusable ? cached.bounds : bounds(s);
      if (!reusable) {
      group = el('g', { 'data-id': s.id, stroke: s.color, 'stroke-width': s.width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      if (s.type === 'rect') group.append(el('rect', { x: b.x, y: b.y, width: b.width, height: b.height, rx: 3 }));
      if (s.type === 'ellipse') group.append(el('ellipse', { cx: b.x + b.width / 2, cy: b.y + b.height / 2, rx: b.width / 2, ry: b.height / 2 }));
      let path;
      if (s.type === 'pen') { path = el('polyline', { 'vector-effect': 'non-scaling-stroke' }); group.append(path); }
      if (s.type === 'arrow') {
        group.append(el('line', { x1: s.x, y1: s.y, x2: s.x2, y2: s.y2 }));
        const a = Math.atan2(s.y2 - s.y, s.x2 - s.x), size = 13 + Number(s.width);
        group.append(el('polyline', { points: `${s.x2 - size * Math.cos(a - .48)},${s.y2 - size * Math.sin(a - .48)} ${s.x2},${s.y2} ${s.x2 - size * Math.cos(a + .48)},${s.y2 - size * Math.sin(a + .48)}` }));
      }
      if (s.type === 'text') {
        const box = el('foreignObject', { x: b.x, y: b.y, width: b.width, height: b.height });
        const text = document.createElement('div'); text.className = 'annotation-text';
        text.style.color = s.color; text.style.fontSize = `${s.fontSize || 28}px`; text.textContent = s.text;
        box.append(text); group.append(box);
      }
      let imageBox;
      if (s.type === 'image') {
        imageBox = el('foreignObject', { x: b.x, y: b.y, width: b.width, height: b.height, 'pointer-events': 'none' });
        imageBox.append(imageAssets.get(s.assetId).canvas); group.append(imageBox);
      }
      const hitArea = el('rect', { x: b.x - 8, y: b.y - 8, width: b.width + 16, height: b.height + 16, fill: 'transparent', stroke: 'none', 'pointer-events': interactive ? 'all' : 'none' });
      group.append(hitArea);
      const entry = { node: group, shape: s, revision: s.revision, interactive, hitArea, imageBox, bounds: b, path };
      shapeNodes.set(s.id, entry);
      if (path) updatePen(entry, s);
      } else if (cached.interactive !== interactive) {
        // Tool switching changes hit testing, not geometry. Preserve paths,
        // foreignObject text and their layout instead of rebuilding every shape.
        cached.hitArea.setAttribute('pointer-events', interactive ? 'all' : 'none');
        cached.interactive = interactive;
      }
      nodes.push(group);
      if (s.id === selected && options.tool === 'select') {
        nodes.push(el('rect', { x: b.x - 7, y: b.y - 7, width: b.width + 14, height: b.height + 14, stroke: '#176951', 'stroke-width': 1, 'stroke-dasharray': '5 4', fill: 'none', 'pointer-events': 'none' }));
        nodes.push(el('rect', { x: b.x + b.width + 2, y: b.y + b.height + 2, width: 10, height: 10, fill: '#176951', stroke: 'white', 'data-handle': s.id, style: 'cursor:nwse-resize' }));
      }
    }
    if (cropMode) {
      const d = drag?.kind === 'crop' ? drag : null;
      const x = d ? Math.min(d.start.x, d.end.x) : 0, y = d ? Math.min(d.start.y, d.end.y) : 0;
      const w = d ? Math.abs(d.end.x - d.start.x) : 0, h = d ? Math.abs(d.end.y - d.start.y) : 0;
      nodes.push(el('path', { d: `M0 0H${viewWidth()}V${innerHeight}H0Z M${x} ${y}v${h}h${w}v-${h}Z`, fill: '#0d1e29', opacity: .45, 'fill-rule': 'evenodd' }));
      nodes.push(el('rect', { x, y, width: w, height: h, fill: 'none', stroke: '#7fffd4', 'stroke-width': 2, 'stroke-dasharray': '6 4' }));
    }
    for (const id of shapeNodes.keys()) if (!visibleIds.has(id)) shapeNodes.delete(id);
    nodes.forEach((node, index) => { if (svg.children[index] !== node) svg.insertBefore(node, svg.children[index] || null); });
    while (svg.children.length > nodes.length) svg.lastElementChild.remove();
    hint.hidden = !cropMode;
    hintLabel.textContent = '拖动框选 · 松开鼠标开始录制';
  }
  function finishText(commit = true) {
    if (!editor) return;
    const input = editor, old = editShape, value = input.value;
    const rect = input.getBoundingClientRect();
    const boxWidth = rect.width, boxHeight = Math.max(rect.height, input.scrollHeight + 2);
    editor = null; editShape = null;
    if (commit && value.trim() && (!old || value !== old.text || boxWidth !== old.boxWidth || boxHeight !== old.boxHeight)) {
      snap();
      if (old) { const copy = editable(old); Object.assign(copy, { text: value, color: input.dataset.color, fontSize: Number(input.dataset.size), boxWidth, boxHeight }); changed(copy); }
      else if (allowShape()) shapes.push({ id: crypto.randomUUID(), type: 'text', x: Number(input.dataset.x), y: Number(input.dataset.y), text: value, color: input.dataset.color, fontSize: Number(input.dataset.size), width: options.width, boxWidth, boxHeight });
    } else if (commit && old && !value.trim()) { snap(); shapes = shapes.filter(s => s.id !== old.id); }
    trimHistory(); input.remove(); render();
  }
  function editText(p, shape) {
    finishText();
    if (archived) { shapes = []; history = []; future = []; archived = false; }
    editShape = shape || null;
    editor = document.createElement('textarea'); editor.className = 'editor';
    editor.setAttribute('aria-label', '在网页输入标注文字'); editor.placeholder = '输入文字'; editor.maxLength = 1000;
    const size = shape?.fontSize || options.fontSize;
    const x = shape?.x ?? Math.min(p.x, Math.max(0, viewWidth() - 180));
    const y = shape?.y ?? Math.min(p.y + size, innerHeight - 30);
    Object.assign(editor.dataset, { x, y, color: shape?.color || options.color, size });
    Object.assign(editor.style, { left: `${x}px`, top: `${Math.max(0, y - size)}px`, color: shape?.color || options.color, fontSize: `${size}px`, width: `${shape ? bounds(shape).width : Math.min(viewWidth() - x, 260)}px`, height: `${shape ? bounds(shape).height : 90}px` });
    editor.value = shape?.text || '';
    editor.addEventListener('input', () => { if (editor) editor.style.height = `${Math.max(editor.getBoundingClientRect().height, editor.scrollHeight + 2)}px`; });
    for (const name of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'click', 'dblclick']) editor.addEventListener(name, e => e.stopPropagation());
    editor.addEventListener('keydown', e => { if (!e.isComposing && e.key === 'Escape') { e.preventDefault(); finishText(false); } });
    editor.addEventListener('blur', () => finishText());
    root.append(editor); render(); editor.focus();
  }
  function endDrag() {
    flushMove();
    if (drag?.matrix) {
      const s = shapes.find(s => s.id === drag.id);
      if (s) {
        const [sx, , , sy, dx, dy] = drag.matrix;
        s.points = drag.original.points.map(p => ({ x: p.x * sx + dx, y: p.y * sy + dy }));
        changed(s);
      }
    }
    if (drag && (drag.kind === 'draw' || drag.changed)) trimHistory();
    drag = null;
    const pointerId = capturedPointer; capturedPointer = null;
    try { if (pointerId !== null && svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId); }
    catch { /* The browser may already have cancelled this pointer. */ }
  }
  async function insertImage(settings = {}) {
    const src = settings.image?.src;
    const match = typeof src === 'string' && src.length <= 2800000 && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(src);
    if (!match) return { ok: false, error: '图片无效，请重新选择 PNG、JPG 或 WebP。' };
    if (cropMode || settings.sessionId && settings.sessionId !== annotationSession) return { ok: false, error: '录制状态已变化，请重新添加图片。' };
    const epoch = annotationEpoch;
    let bitmap;
    try {
      const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: match[1] });
      bitmap = await decodeImage(blob);
      if (!(bitmap.width > 0 && bitmap.height > 0) || Math.max(bitmap.width, bitmap.height) > 1600) throw new Error('图片尺寸过大，请通过侧栏重新添加。');
      if (epoch !== annotationEpoch || !host.isConnected || cropMode || settings.sessionId && settings.sessionId !== annotationSession) throw new Error('网页或录制状态已变化，请重新添加图片。');
      finishText(); endDrag();
      if (archived) { shapes = []; history = []; future = []; archived = false; }
      pruneImageAssets();
      if (!allowShape()) throw new Error('本页标注较多，请删除部分图形后继续。');
      const imageBytes = bitmap.width * bitmap.height * 4;
      while ((annotationResources().reservedImageBytes + imageBytes > limits.imageBytes || annotationResources().storedImageBytes + blob.size > limits.storedImageBytes) && (history.length || future.length)) {
        if (history.length) history.shift(); else future.shift(); pruneImageAssets();
      }
      if (annotationResources().reservedImageBytes + imageBytes > limits.imageBytes || annotationResources().storedImageBytes + blob.size > limits.storedImageBytes) throw new Error('本页图片较多，请删除部分图片后重试。');
      const raster = document.createElement('canvas'); raster.width = bitmap.width; raster.height = bitmap.height;
      Object.assign(raster.style, { width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
      const ctx = raster.getContext('2d');
      if (!ctx) throw new Error('无法显示图片，请重新添加。');
      ctx.drawImage(bitmap, 0, 0);
      snap();
      // The original crop stores absolute CSS coordinates via its viewport.
      // These stay valid when capture UI settles before recording starts.
      let area = { x: 0, y: 0, width: viewWidth(), height: innerHeight };
      const r = settings.region;
      if ([r?.x, r?.y, r?.width, r?.height, r?.viewportWidth, r?.viewportHeight].every(Number.isFinite)) {
        const candidate = { x: r.x * r.viewportWidth, y: r.y * r.viewportHeight, width: r.width * r.viewportWidth, height: r.height * r.viewportHeight };
        if (candidate.x >= 0 && candidate.y >= 0 && candidate.width > 0 && candidate.height > 0 && candidate.x + candidate.width <= viewWidth() + 1 && candidate.y + candidate.height <= innerHeight + 1) area = candidate;
      }
      const scale = Math.min(1, 480 / bitmap.width, area.width * .6 / bitmap.width, area.height * .6 / bitmap.height);
      const width = bitmap.width * scale, height = bitmap.height * scale, margin = Math.min(16, area.width * .05, area.height * .05);
      const id = crypto.randomUUID(); imageAssets.set(id, { canvas: raster, blob, width: bitmap.width, height: bitmap.height });
      shapes.push({ id, type: 'image', assetId: id, x: area.x + area.width - width - margin, y: area.y + margin, boxWidth: width, boxHeight: height });
      selected = id; options.tool = 'select'; render(); emit('TOOL_CHANGED', { options });
      return { ok: true, count: shapes.length, tool: 'select' };
    } catch (error) { return { ok: false, error: error.message || '图片读取失败，请重新添加。' }; }
    finally { bitmap?.close(); }
  }
  function cancelSelection() { const canceledId = selectionId; cropMode = false; selectionId = null; endDrag(); selected = null; options.tool = 'pointer'; render(); emit('CROP_CANCEL', { selectionId: canceledId }); emit('TOOL_CHANGED', { options }); }
  cancelCrop.addEventListener('click', cancelSelection);
  svg.addEventListener('dblclick', e => {
    if (cropMode || options.tool === 'pointer') return;
    const shape = shapes.find(s => s.id === e.target.closest('[data-id]')?.getAttribute('data-id'));
    if (shape?.type === 'text') { e.preventDefault(); endDrag(); editText(point(e), shape); }
  });
  const point = e => ({ x: Math.max(0, Math.min(viewWidth(), e.clientX)), y: Math.max(0, Math.min(innerHeight, e.clientY)) });
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const p = point(e);
    if (editor) { finishText(); return; }
    if (archived && !cropMode && options.tool !== 'pointer') { shapes = []; history = []; future = []; archived = false; }
    const hit = shapes.find(s => s.id === e.target.closest('[data-id]')?.getAttribute('data-id'));
    if (!cropMode && ['select', 'text'].includes(options.tool) && hit?.type === 'text') {
      if (lastTextHit?.id === hit.id && Date.now() - lastTextHit.at < 450) { lastTextHit = null; endDrag(); editText(p, hit); return; }
      lastTextHit = { id: hit.id, at: Date.now() };
    } else lastTextHit = null;
    if (!cropMode && options.tool === 'text') {
      const shape = shapes.find(s => s.id === e.target.closest('[data-id]')?.getAttribute('data-id'));
      if (shape?.type === 'text') return;
      editText(p); return;
    }
    svg.setPointerCapture(e.pointerId); capturedPointer = e.pointerId;
    if (cropMode) drag = { kind: 'crop', start: p, end: p };
    else if (options.tool === 'select') {
      const handle = e.target.getAttribute('data-handle');
      selected = handle || e.target.closest('[data-id]')?.getAttribute('data-id') || null;
      const s = shapes.find(s => s.id === selected);
      if (s) {
        const cached = shapeNodes.get(s.id);
        drag = { id: s.id, kind: handle ? 'resize' : 'move', start: p, original: s,
          bounds: cached?.shape === s ? cached.bounds : bounds(s), changed: false };
      }
    } else if (options.tool !== 'pointer') {
      if (!allowShape()) { endDrag(); return; }
      const pointBudget = Math.min(limits.strokePoints, limits.scenePoints - shapes.reduce((sum, s) => sum + (s.points?.length || 0), 0));
      if (options.tool === 'pen' && pointBudget < 2) {
        emit('ANNOTATION_ERROR', { error: '本页笔迹较多，请删除部分笔迹后继续。' }); endDrag(); return;
      }
      snap();
      const s = { id: crypto.randomUUID(), type: options.tool, color: options.color, width: Number(options.width), x: p.x, y: p.y, x2: p.x, y2: p.y, fontSize: options.fontSize };
      if (s.type === 'pen') s.points = [p];
      shapes.push(s);
      if (s.type !== 'text') drag = { kind: 'draw', id: s.id, pointBudget };
    }
    render();
  });
  function extendStroke(s, p) {
    s.x2 = p.x; s.y2 = p.y;
    if (s.points) {
      const last = s.points.at(-1);
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 2) {
        // Thin only at the sample budget. Normal frames append new SVG points.
        if (s.points.length >= drag.pointBudget) s.points = s.points.filter((_, i, points) => i === 0 || i === points.length - 1 || i % 2 === 0);
        if (s.points.length >= drag.pointBudget) s.points[s.points.length - 1] = p;
        else s.points.push(p);
      }
    }
    changed(s);
  }
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = point(e);
    if (drag.kind === 'crop') drag.end = p;
    if (drag.kind === 'draw') {
      const s = shapes.find(s => s.id === drag.id);
      if (!s) { endDrag(); render(); return; }
      extendStroke(s, p);
    }
    if (['move', 'resize'].includes(drag.kind)) pendingMove = p;
    scheduleRender();
  });
  function flushMove() {
    const p = pendingMove; pendingMove = null;
    if (!p || !drag || !['move', 'resize'].includes(drag.kind)) return;
    let s = shapes.find(s => s.id === selected);
    if (!s) { endDrag(); selected = null; render(); return; }
    const original = drag.original, b = drag.bounds;
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (!drag.changed && dx === 0 && dy === 0) return;
    if (!drag.changed) { snap(); s = editable(s); drag.changed = true; }
    const sx = Math.max(12, b.width + dx) / b.width, sy = Math.max(12, b.height + dy) / b.height;
    const transform = v => drag.kind === 'move' ? { x: v.x + dx, y: v.y + dy } : { x: b.x + (v.x - b.x) * sx, y: b.y + (v.y - b.y) * sy };
    Object.assign(s, transform(original));
    if (original.x2 !== undefined) { const end = transform({ x: original.x2, y: original.y2 }); s.x2 = end.x; s.y2 = end.y; }
    if (original.points) {
      drag.matrix = drag.kind === 'move' ? [1, 0, 0, 1, dx, dy] : [sx, 0, 0, sy, b.x * (1 - sx), b.y * (1 - sy)];
      drag.visualBounds = drag.kind === 'move' ? { ...b, x: b.x + dx, y: b.y + dy } : { ...b, width: b.width * sx, height: b.height * sy };
    }
    if (s.type === 'text' && drag.kind === 'resize') {
      s.fontSize = Math.max(12, Math.min(120, (original.fontSize || 28) * sx));
      const scale = s.fontSize / (original.fontSize || 28);
      s.boxWidth = (b.width - 10) * scale + 10; s.boxHeight = (b.height - 10) * scale + 10; s.y = b.y + s.fontSize;
    }
    if (s.type === 'image' && drag.kind === 'resize') {
      const change = Math.abs(dx / b.width) >= Math.abs(dy / b.height) ? dx / b.width : dy / b.height;
      const scale = Math.max(12 / b.width, 12 / b.height, 1 + change);
      s.boxWidth = b.width * scale; s.boxHeight = b.height * scale;
    }
    changed(s);
  }
  function finish(e) {
    if (!drag) return;
    if (drag.kind === 'draw' && Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
      const s = shapes.find(s => s.id === drag.id); if (s) extendStroke(s, point(e));
    }
    if (['move', 'resize'].includes(drag.kind) && Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) pendingMove = point(e);
    if (drag.kind === 'crop') {
      if (Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) drag.end = point(e);
      const { start, end } = drag;
      if (Math.abs(start.x - end.x) >= 24 && Math.abs(start.y - end.y) >= 24) {
        emit('CROP', { selectionId, crop: { x: Math.min(start.x, end.x) / viewWidth(), y: Math.min(start.y, end.y) / innerHeight,
          width: Math.abs(start.x - end.x) / viewWidth(), height: Math.abs(start.y - end.y) / innerHeight,
          viewportWidth: viewWidth(), viewportHeight: innerHeight } });
        cropMode = false; selectionId = null; options.tool = 'pointer';
      }
    }
    endDrag();
    render();
  }
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', () => { endDrag(); render(); });
  document.addEventListener('keydown', e => {
    if (editor && e.composedPath().includes(editor)) return;
    if (e.key === 'Escape' && cropMode) { e.preventDefault(); cancelSelection(); }
    else if (e.key === 'Escape' && options.tool !== 'pointer') { endDrag(); options.tool = 'pointer'; selected = null; render(); emit('TOOL_CHANGED', { options }); }
  }, true);
  document.addEventListener('pointerdown', e => {
    if (e.composedPath().includes(host)) return;
    if (!options.clicks || cropMode || options.tool !== 'pointer') return;
    const ring = document.createElement('div'); ring.className = 'click';
    ring.style.left = `${e.clientX}px`; ring.style.top = `${e.clientY}px`;
    root.append(ring); setTimeout(() => ring.remove(), 700);
  }, true);
  function handle(message) {
    if (message.type === 'RESTORE' && archived && [...imageAssets.values()].some(a => !a.canvas.width)) {
      if (restoringImages && restoringEpoch === annotationEpoch) return restoringImages;
      return ensureImagePixels(++annotationEpoch, true);
    }
    if (message.type === 'PING') return { ok: true, width: viewWidth(), height: innerHeight, options, archived: archived && shapes.length > 0, cropMode, selectionId,
      ...(message.options?.resources ? { resources: annotationResources() } : {}) };
    if (message.type === 'END' && message.options?.sessionId && annotationSession && message.options.sessionId !== annotationSession) return { ok: true, ignored: true };
    if (['BEGIN', 'END', 'CROP', 'CLEAR', 'RESTORE', 'UNDO', 'REDO', 'DELETE'].includes(message.type)) annotationEpoch++;
    if (message.type === 'PERF_BASELINE') {
      const sessionId = message.options?.sessionId || message.sessionId;
      if (!sessionId || performanceProbe?.phase === 'recording' || performanceProbe?.phase === 'recovery' && performanceProbe.sessionId === sessionId) return { ok: true, ignored: true };
      if (diagnosticsSession !== sessionId) recoveredSession = null;
      diagnosticsSession = sessionId; baselineSession = sessionId;
      startPerformanceProbe(sessionId, 'baseline');
      return { ok: true, measuring: true };
    }
    if (['CROP', 'SET', 'BEGIN', 'END', 'CLEAR', 'UNDO', 'REDO', 'RESTORE'].includes(message.type)) finishText(message.type !== 'END');
    if (['CROP', 'SET', 'BEGIN', 'END', 'CLEAR', 'UNDO', 'REDO', 'RESTORE', 'DELETE'].includes(message.type)) endDrag();
    if (message.type === 'CROP') { cropMode = true; selectionId = message.options?.selectionId || null; selected = null; drag = null; }
    if (message.type === 'CANCEL_CROP') {
      if (message.options?.selectionId && message.options.selectionId !== selectionId) return { ok: true, ignored: true };
      cancelSelection();
    }
    if (message.type === 'BEGIN') {
      annotationSession = message.options?.sessionId || null;
      beginDiagnostics(message.options);
      // A repeated BEGIN after navigation checks must not replace the baseline
      // confirmed after capture started, or re-enable an already reported guard.
      if (recordingViewport?.sessionId !== message.options?.sessionId) {
        finishViewportWait({ ok: false, error: '框选录制准备已结束，请重新开始。' });
        recordingViewport = message.options?.crop ? { ...message.options.crop, sessionId: message.options.sessionId,
          pending: !!message.options.deferViewport, reported: false } : null;
      }
      if (archived) { shapes = []; history = []; future = []; }
      pruneImageAssets();
      archived = false; cropMode = false; selectionId = null; drag = null; selected = null;
      options.tool = 'pointer'; options.clicks = !!message.options?.clicks;
    }
    if (message.type === 'END') {
      annotationSession = null;
      endDiagnostics(message.options);
      finishViewportWait({ ok: false, error: '框选录制准备已取消。' });
      recordingViewport = null;
      archived = true; cropMode = false; selectionId = null; drag = null; selected = null;
      // Keep the final annotations available for Restore, but do not retain
      // all old geometry and deleted image pixels after recording has ended.
      history = []; future = []; pruneImageAssets();
      releaseImagePixels();
      options.tool = 'pointer'; options.clicks = false;
    }
    if (message.type === 'RESTORE') { archived = false; options.tool = 'pointer'; }

    if (message.type === 'ARM_VIEWPORT') {
      const area = message.options?.crop;
      if (!area || !recordingViewport || recordingViewport.sessionId !== message.options?.sessionId) return { ok: false, error: '框选录制准备已结束，请重新开始。' };
      if (!sameViewport(area)) return { ok: false, error: '网页尺寸仍在变化，请保持窗口稳定后重新录制。' };
      recordingViewport = { ...area, sessionId: message.options.sessionId, pending: false, reported: false };
    }

    if (message.type === 'SET') {
      options = { ...options, ...message.options };
      cropMode = false; drag = null;
      if (message.options?.tool && message.options.tool !== 'select') selected = null;
      let s = shapes.find(s => s.id === selected);
      if (s && s.type !== 'image' && (message.options.color || message.options.width || message.options.fontSize)) {
        snap(); s = editable(s);
        if (s.type === 'text' && message.options.fontSize) {
          const b = bounds(s), scale = message.options.fontSize / (s.fontSize || 28);
          s.boxWidth = (b.width - 10) * scale + 10; s.boxHeight = (b.height - 10) * scale + 10; s.y = b.y + message.options.fontSize;
        }
        for (const key of ['color', 'width', 'fontSize']) if (message.options[key]) s[key] = message.options[key];
        changed(s);
        const cached = shapeNodes.get(s.id);
        if (s.type === 'pen' && cached) updatePen(cached, s);
      }
      emit('TOOL_CHANGED', { options });
    }
    if (message.type === 'UNDO' && history.length) { future.push(shapes.slice()); shapes = history.pop(); selected = null; }
    if (message.type === 'REDO' && future.length) { history.push(shapes.slice()); shapes = future.pop(); selected = null; }
    if (message.type === 'CLEAR' && shapes.length) { snap(); shapes = []; selected = null; archived = false; }
    if (message.type === 'DELETE' && selected) { snap(); shapes = shapes.filter(s => s.id !== selected); selected = null; }
    if (['UNDO', 'REDO', 'CLEAR', 'DELETE'].includes(message.type)) trimHistory();
    if (!archived && shapes.some(s => s.type === 'image' && !imageAssets.get(s.assetId)?.canvas.width)) return ensureImagePixels(annotationEpoch);
    render(); return { ok: true, count: shapes.length, tool: options.tool };
  }
  if (extension) {
    messageListener = (message, sender, reply) => {
    if (message.target !== 'overlay') return;
    if (message.type === 'INSERT_IMAGE') { insertImage(message.options).then(reply); return true; }
    if (message.type === 'CAPTURE_VIEWPORT') { settleViewport(message.options, reply); return true; }
    const result = handle(message);
    if (result?.then) { result.then(reply, error => reply({ ok: false, error: error.message })); return true; }
    if (message.type === 'BEGIN') {
      // Let the compositor remove the crop mask/editor before capture starts.
      let answered = false;
      const respond = value => { if (!answered) { answered = true; clearTimeout(timer); reply(value); } };
      const timer = setTimeout(() => respond({ ok: false, error: '网页没有及时准备好画面，请保持目标网页可见后重试。' }), 2000);
      requestAnimationFrame(() => requestAnimationFrame(() => respond(result)));
      return true;
    }
    reply(result);
    };
    chrome.runtime.onMessage.addListener(messageListener);
  }
  else window.addEventListener('yinglu-demo-command', e => {
    if (e.detail.type === 'INSERT_IMAGE') insertImage(e.detail.options).then(result => { if (!result.ok) emit('ANNOTATION_ERROR', { error: result.error }); });
    else {
      const result = handle(e.detail);
      if (result?.then) result.then(value => { if (!value.ok) emit('ANNOTATION_ERROR', { error: value.error }); });
    }
  });
  globalThis.addEventListener?.('resize', () => {
    if (viewportWait) Object.assign(viewportWait, { width: viewWidth(), height: innerHeight, changedAt: probeNow() });
    const area = recordingViewport;
    if (!area || area.pending || area.reported || sameViewport(area)) return;
    area.reported = true;
    emit('VIEWPORT_RESIZE', { sessionId: area.sessionId, width: viewWidth(), height: innerHeight });
  });
  document.addEventListener('fullscreenchange', () => {
    // A top-layer fullscreen element otherwise hides document-level annotations.
    const parent = document.fullscreenElement || document.documentElement;
    if (!['CANVAS', 'VIDEO', 'IFRAME'].includes(parent.tagName)) parent.append(host);
  });
  render();
  globalThis.__yingluOverlay = { host };
  return { ok: true };
  } catch (error) {
    host?.remove();
    if (messageListener) globalThis.chrome?.runtime?.onMessage?.removeListener(messageListener);
    delete globalThis.__yingluOverlay;
    return { ok: false, error: `${error.name || 'Error'}: ${error.message || error}` };
  }
})();
