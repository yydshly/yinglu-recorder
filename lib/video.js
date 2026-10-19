import { cropPixels, outputSize } from './geometry.js';

const aborted = signal => signal?.reason || new DOMException('已取消准备录制', 'AbortError');
function reportedSettings(settings = {}) {
  return { width: settings.width ?? null, height: settings.height ?? null, frameRateSetting: settings.frameRate ?? null };
}
async function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw aborted(signal);
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(aborted(signal)); signal.addEventListener('abort', listener, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', listener); }
}

function sameAspect(width, height, referenceWidth, referenceHeight) {
  const scale = Math.min(width / referenceWidth, height / referenceHeight);
  return Math.max(Math.abs(width - referenceWidth * scale), Math.abs(height - referenceHeight * scale)) <= 2;
}

function matchesViewportAspect(width, height, crop) {
  // The viewport guard allows two CSS pixels on each axis. Capture resolution
  // can have any uniform scale (DPR or downscaling), so compare possible scale
  // intervals rather than applying a two-physical-pixel threshold to CSS sizes.
  // One decoded pixel accounts for integer frame-size rounding.
  const cssError = 2, pixelError = 1;
  const low = Math.max((width - pixelError) / (crop.viewportWidth + cssError),
    (height - pixelError) / (crop.viewportHeight + cssError));
  const high = Math.min((width + pixelError) / Math.max(1, crop.viewportWidth - cssError),
    (height + pixelError) / Math.max(1, crop.viewportHeight - cssError));
  return low <= high;
}

// GUM_TAB_VIDEO_CAPTURE uses a fixed-resolution container in Chromium. The
// viewport can be centered inside it with letter/pillarboxing, so the frame's
// aspect ratio is not evidence that the confirmed CSS viewport is unstable.
function tabContentRect(width, height, crop) {
  if (matchesViewportAspect(width, height, crop)) return { x: 0, y: 0, width, height };
  const scale = Math.min(width / crop.viewportWidth, height / crop.viewportHeight);
  let w = Math.min(width, Math.round(crop.viewportWidth * scale));
  let h = Math.min(height, Math.round(crop.viewportHeight * scale));
  let x = Math.floor((width - w) / 2), y = Math.floor((height - h) / 2);
  // Chromium's I420/NV12 content rectangles align origin and extent to chroma
  // samples. Odd-size frames use the ordinary centered RGB rectangle instead.
  if (width % 2 === 0 && height % 2 === 0) {
    if (w % 2) w += x % 2 ? 1 : -1;
    if (h % 2) h += y % 2 ? 1 : -1;
    x -= x % 2; y -= y % 2;
  }
  if (w < 1 || h < 1) throw new Error('采集画面中的网页区域过小，请扩大网页窗口后重新录制。');
  return { x, y, width: w, height: h };
}

async function waitForViewportFrame(video, crop, signal, tabLayout) {
  if (!(crop?.viewportWidth > 0 && crop?.viewportHeight > 0)) return;
  const matches = () => video.videoWidth > 0 && video.videoHeight > 0 &&
    (tabLayout || matchesViewportAspect(video.videoWidth, video.videoHeight, crop));
  if (matches()) return;
  let timer, poll, check, active = true;
  try {
    await waitFor(new Promise((resolve, reject) => {
      check = () => { if (!active) return; clearTimeout(poll); if (matches()) resolve(); else poll = setTimeout(check, 50); };
      video.addEventListener?.('resize', check);
      timer = setTimeout(() => {
        const error = new Error('框选视口与采集画面不匹配，尚未开始录制。请查看错误详情。');
        error.detail = JSON.stringify({ code: 'CAPTURE_VIEWPORT_MISMATCH',
          viewport: { width: crop.viewportWidth, height: crop.viewportHeight },
          frame: { width: video.videoWidth, height: video.videoHeight },
          layout: tabLayout ? 'chrome-tab' : 'full-frame' }, null, 2);
        reject(error);
      }, 2000);
      check();
    }), signal);
  } finally { active = false; clearTimeout(timer); clearTimeout(poll); video.removeEventListener?.('resize', check); }
}

// Bound the entire decoded source, including small selections. Original
// quality is the explicit opt-out when fine text matters more than load.
export function sourceConstraints(settings, options = {}) {
  const fps = options.fps === 20 ? 20 : options.fps === 60 ? 60 : 30;
  const lowLoad = options.quality === 'performance';
  const max = options.quality === 'original' ? Infinity : options.quality === '720' || lowLoad ? 1280 : 1920;
  const constraints = { frameRate: { ideal: fps, max: fps } };
  if (!Number.isFinite(max)) return constraints;
  if (settings.width > 0 && settings.height > 0) {
    const scale = Math.min(1, max / Math.max(settings.width, settings.height));
    const width = Math.max(2, Math.floor(settings.width * scale));
    const height = Math.max(2, Math.floor(settings.height * scale));
    constraints.width = { ideal: width, max: width }; constraints.height = { ideal: height, max: height };
  } else { constraints.width = { max }; constraints.height = { max }; }
  return constraints;
}

export async function createVideoOutput(source, options = {}) {
  // Acquisition has confirmed the viewport. Keep this session's rectangle
  // independent of later UI/settings changes, including during async setup.
  options = { ...options, crop: options.crop ? Object.freeze({ ...options.crop }) : null };
  const track = source.getVideoTracks()[0];
  if (!track) throw new Error('录制来源没有视频画面');
  const signal = options.signal;
  // Only the known Chrome tab producer may use its centered-content contract.
  // Generic/desktop sources retain the strict full-frame aspect check.
  const tabLayout = options.captureLayout === 'chrome-tab' && options.crop?.viewportWidth > 0 && options.crop?.viewportHeight > 0;
  const beforeConstraints = reportedSettings(track.getSettings());
  const fps = options.fps === 20 ? 20 : options.fps === 60 ? 60 : 30;
  const max = options.quality === 'original' ? Infinity : ['720', 'performance'].includes(options.quality) ? 1280 : 1920;
  let constrained = false;
  try { await waitFor(track.applyConstraints(sourceConstraints(track.getSettings(), options)), signal); constrained = true; }
  catch {
    if (signal?.aborted) throw aborted(signal);
    try { await waitFor(track.applyConstraints({ frameRate: { ideal: fps, max: fps } }), signal); constrained = true; }
    catch { if (signal?.aborted) throw aborted(signal); }
  }
  const settings = { ...track.getSettings() };
  const describe = (pipeline, outputSettings) => ({ pipeline, requestedFrameRate: fps,
    sourceSettingsBeforeConstraints: { ...beforeConstraints }, sourceSettings: reportedSettings(settings),
    outputSettings: reportedSettings(outputSettings), settingsAreNotMeasuredFps: true });
  if (!options.crop && constrained && settings.width > 0 && settings.height > 0 &&
      Math.max(settings.width, settings.height) <= max && (settings.frameRate || fps) <= fps + .1) {
    return { stream: new MediaStream([track]), width: settings.width, height: settings.height,
      mode: 'direct', setPaused() {}, cleanup() {}, getPerformance: () => describe('direct', settings) };
  }
  const video = document.createElement('video');
  let timer, watchdog, frameCallback, output, canvas, outputWidth, outputHeight;
  let closed = false, resized = false, scheduleEpoch = 0;
  const metrics = { drawnFrames: 0, drawSubmitMsTotal: 0, drawSubmitMsMax: 0, frameCallbacks: 0,
    duplicateFramesSkipped: 0, pacingFramesSkipped: 0, fallbackActivations: 0, fallbackDrawnFrames: 0,
    playbackTotalVideoFrames: null, playbackDroppedVideoFrames: null, playbackCorruptedVideoFrames: null,
    sourceResolutionChanges: 0, playbackQualityReads: 0 };
  function readPlaybackQuality() {
    if (!video.getVideoPlaybackQuality) return;
    const quality = video.getVideoPlaybackQuality(); metrics.playbackQualityReads++;
    metrics.playbackTotalVideoFrames = quality.totalVideoFrames ?? null;
    metrics.playbackDroppedVideoFrames = quality.droppedVideoFrames ?? null;
    metrics.playbackCorruptedVideoFrames = quality.corruptedVideoFrames ?? null;
    return quality;
  }
  function stopScheduling() {
    scheduleEpoch++;
    clearInterval(timer); clearInterval(watchdog); timer = watchdog = undefined;
    if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
    frameCallback = undefined;
  }
  const cleanup = () => {
    if (closed) return;
    closed = true; stopScheduling();
    video.removeEventListener?.('resize', checkVideoSize);
    signal?.removeEventListener('abort', cleanup);
    output?.getTracks().forEach(t => t.stop());
    video.pause(); video.srcObject = null; video.load?.();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  };
  let sourceWidth, sourceHeight, area, contentRect, previousFrames = -1, previousCounter;
  function mapCrop(width, height) {
    contentRect = tabLayout ? tabContentRect(width, height, options.crop) : { x: 0, y: 0, width, height };
    const rect = cropPixels(options.crop, contentRect.width, contentRect.height);
    return { ...rect, x: rect.x + contentRect.x, y: rect.y + contentRect.y };
  }
  function checkVideoSize() {
    if (!options.crop || !sourceWidth || resized || closed) return;
    const width = video.videoWidth, height = video.videoHeight;
    if (!(width > 0 && height > 0) || width === sourceWidth && height === sourceHeight) return;
    // Track settings and decoded dimensions need not change in the same task.
    // Only the decoded frame determines the pixels drawImage actually reads.
    // The CSS guard owns real viewport changes. A known Chrome tab container
    // can change aspect while keeping that viewport centered inside the frame.
    const matches = tabLayout || (options.crop.viewportWidth > 0 && options.crop.viewportHeight > 0
      ? matchesViewportAspect(width, height, options.crop) : sameAspect(width, height, sourceWidth, sourceHeight));
    if (matches) {
      sourceWidth = width; sourceHeight = height;
      area = mapCrop(width, height);
      previousFrames = -1; metrics.sourceResolutionChanges++;
      return;
    }
    resized = true;
    options.onSourceResize?.('录制来源宽高比发生变化，已停止并保存现有片段。请重新框选后开始录制。');
  }
  signal?.addEventListener('abort', cleanup, { once: true });
  try {
    video.muted = true; video.playsInline = true; video.srcObject = source;
    await waitFor(video.play(), signal);
    if (!video.videoWidth) throw new Error('未能取得视频画面，请重新选择录制来源');
    // Fixed-resolution Chrome tab frames need not share the viewport's aspect;
    // map its centered content instead of waiting for an impossible frame size.
    await waitForViewportFrame(video, options.crop, signal, tabLayout);
    sourceWidth = video.videoWidth; sourceHeight = video.videoHeight;
    video.addEventListener?.('resize', checkVideoSize);
    area = mapCrop(sourceWidth, sourceHeight);
    canvas = document.createElement('canvas');
    Object.assign(canvas, outputSize(area.width, area.height, options.quality));
    outputWidth = canvas.width; outputHeight = canvas.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建录制画布');
    output = canvas.captureStream(0);
    const outputTrack = output.getVideoTracks()[0];
    if (!outputTrack.requestFrame) { outputTrack.stop(); output = canvas.captureStream(fps); }
    let paused = false, nextFrameAt = -Infinity, lastCallback = performance.now();
    const render = (now = performance.now(), frameDriven = false, timerDriven = false, metadata) => {
      checkVideoSize();
      if (closed || resized || paused || video.readyState < 2) return;
      if (frameDriven && now + 1 < nextFrameAt) { metrics.pacingFramesSkipped++; return; }
      // The native callback already identifies a new presented frame. Only
      // timer fallback and occasional diagnostics need playback-quality reads.
      const nativeCounter = Number.isFinite(metadata?.presentedFrames) && metadata.presentedFrames > 0;
      const counter = nativeCounter ? 'presented' : 'quality';
      const frames = nativeCounter ? metadata.presentedFrames : readPlaybackQuality()?.totalVideoFrames;
      if (frames > 0 && counter === previousCounter && frames === previousFrames) { metrics.duplicateFramesSkipped++; return; }
      previousFrames = frames; previousCounter = counter;
      const interval = 1000 / fps;
      nextFrameAt = !Number.isFinite(nextFrameAt) || now - nextFrameAt > interval * 2 ? now + interval : nextFrameAt + interval;
      const c = options.crop ? area : cropPixels(null, video.videoWidth, video.videoHeight);
      const fit = Math.min(canvas.width / c.width, canvas.height / c.height);
      const width = c.width * fit, height = c.height * fit;
      const drawStarted = performance.now();
      if (Math.abs(width - canvas.width) > .5 || Math.abs(height - canvas.height) > .5) {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(video, c.x, c.y, c.width, c.height, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      output.getVideoTracks()[0].requestFrame?.();
      const submitMs = performance.now() - drawStarted;
      metrics.drawnFrames++; metrics.drawSubmitMsTotal += submitMs;
      metrics.drawSubmitMsMax = Math.max(metrics.drawSubmitMsMax, submitMs);
      if (timerDriven) metrics.fallbackDrawnFrames++;
    };
    function startScheduling() {
      const epoch = scheduleEpoch;
      const current = () => !closed && !paused && epoch === scheduleEpoch;
      const fallback = () => { if (current()) render(performance.now(), false, true); };
      if (video.requestVideoFrameCallback) {
        const onFrame = (now, metadata) => {
          if (!current()) return;
          frameCallback = undefined; metrics.frameCallbacks++; lastCallback = performance.now();
          if (timer !== undefined) { clearInterval(timer); timer = undefined; }
          render(now, true, false, metadata);
          if (current()) frameCallback = video.requestVideoFrameCallback(onFrame);
        };
        lastCallback = performance.now();
        frameCallback = video.requestVideoFrameCallback(onFrame);
        // Offscreen renderers can starve callbacks; use the timer only then.
        watchdog = setInterval(() => {
          if (!current()) return;
          checkVideoSize();
          if (current() && timer === undefined && performance.now() - lastCallback > 500) {
            metrics.fallbackActivations++; timer = setInterval(fallback, 1000 / fps);
          }
        }, 250);
      } else {
        metrics.fallbackActivations++; timer = setInterval(fallback, 1000 / fps);
      }
    }
    render(); startScheduling();
    return { stream: output, width: outputWidth, height: outputHeight, mode: 'canvas',
      getPerformance: () => {
        if (!closed) readPlaybackQuality();
        return { ...describe('canvas', { width: outputWidth, height: outputHeight,
        frameRate: output.getVideoTracks()[0].getSettings?.().frameRate ?? null }),
        canvas: { ...metrics, decodedSourceWidth: sourceWidth, decodedSourceHeight: sourceHeight,
          captureLayout: tabLayout ? 'chrome-tab' : 'full-frame', contentRect: { ...contentRect }, cropRect: { ...area },
          frameCallbackAvailable: !!video.requestVideoFrameCallback, sourceResized: resized } };
      },
      setPaused(value) {
        if (closed || paused === !!value) return;
        paused = !!value; stopScheduling();
        if (paused) { video.pause(); return; }
        previousFrames = -1; nextFrameAt = -Infinity; render();
        if (closed || resized) return;
        startScheduling();
        const epoch = scheduleEpoch;
        try {
          Promise.resolve(video.play()).catch(cause => {
            if (closed || paused || epoch !== scheduleEpoch) return;
            paused = true; stopScheduling(); video.pause();
            options.onSourceResize?.(`裁切画面恢复播放失败，已停止并保存现有片段：${cause?.message || cause}`);
          });
        } catch (cause) {
          paused = true; stopScheduling(); video.pause();
          options.onSourceResize?.(`裁切画面恢复播放失败，已停止并保存现有片段：${cause?.message || cause}`);
        }
      }, cleanup };
  } catch (error) { cleanup(); throw error; }
}
