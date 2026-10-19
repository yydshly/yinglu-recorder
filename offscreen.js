import { Recorder } from './lib/recorder.js';
const recorder = new Recorder(state => {
  chrome.runtime.sendMessage({ target: 'background', type: 'STATE', state }).catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'offscreen') return;
  (async () => {
    if (message.type === 'START') {
      const constraints = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } };
      const video = { mandatory: { ...constraints.mandatory, maxFrameRate: message.options.fps === 20 ? 20 : message.options.fps === 60 ? 60 : 30 } };
      // Apply the selected source budget before the first decoder is created.
      // Small crops must not silently keep a full 4K source in ordinary modes.
      if (message.options.quality !== 'original') {
        const max = ['720', 'performance'].includes(message.options.quality) ? 1280 : 1920;
        Object.assign(video.mandatory, { maxWidth: max, maxHeight: max });
      }
      const options = { ...message.options, context: { ...message.options.context }, monitor: true, captureLayout: 'chrome-tab' };
      await recorder.start(async signal => {
        const stream = await navigator.mediaDevices.getUserMedia({ video, audio: options.audio ? constraints : false });
        const stop = () => stream.getTracks().forEach(track => track.stop());
        signal?.addEventListener('abort', stop, { once: true });
        try {
          signal?.throwIfAborted();
          if (options.crop) {
            // Tab capture can introduce browser sharing UI and resize the CSS
            // viewport. Confirm the rectangle only after the real stream exists.
            const confirmed = await chrome.runtime.sendMessage({ target: 'background', type: 'CAPTURE_VIEWPORT_READY', sessionId: options.context.sessionId });
            signal?.throwIfAborted();
            if (!confirmed?.ok) throw new Error(confirmed?.error || '未能确认框选范围，请重新录制。');
            options.crop = confirmed.crop;
            options.context = { ...options.context, cropViewport: confirmed.cropViewport, cropViewportPending: false };
          }
          return stream;
        } catch (error) { stop(); throw error; }
        finally { signal?.removeEventListener('abort', stop); }
      }, options);
    } else if (message.type === 'STATUS') return { ok: true, state: recorder.state };
    else if (message.sessionId && message.sessionId !== recorder.state.sessionId) return { ok: true, ignored: true, state: recorder.state };
    else if (message.type === 'PAUSE') recorder.pause();
    else if (message.type === 'RESUME') recorder.resume();
    else if (message.type === 'MUSIC') await recorder.controlMusic(message.command, message.value);
    else if (message.type === 'STOP') recorder.stop(message.error);
    return { ok: true, state: recorder.state };
  })().then(reply).catch(error => reply({ ok: false, cancelled: error.name === 'AbortError', error: error.message, detail: error.detail, state: recorder.state }));
  return true;
});
