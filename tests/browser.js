import { Recorder } from '../lib/recorder.js';
import { getRecording, recordingBlob, deleteRecording } from '../lib/db.js';
const result = document.getElementById('result');
const wait = ms => new Promise(r => setTimeout(r, ms));
const assert = (ok, text) => { if (!ok) throw new Error(text); result.textContent += `\nPASS ${text}`; };
document.getElementById('run').onclick = async () => {
  const button = document.getElementById('run'); button.disabled = true; result.textContent = '运行中…';
  const canvas = document.getElementById('source'), ctx = canvas.getContext('2d');
  let frame = 0, timer, stream, audio, id, previewUrl, recorder, boxedCase;
  try {
    const draw = () => {
      const box = boxedCase || { x: 0, y: 0, width: canvas.width, height: canvas.height };
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ff0000'; ctx.fillRect(box.x, box.y, box.width / 2, box.height);
      ctx.fillStyle = '#0000ff'; ctx.fillRect(box.x + box.width / 2, box.y, box.width / 2, box.height);
      ctx.fillStyle = '#fff'; ctx.fillText(`Frame ${frame++}`, box.x + box.width * .66, box.y + box.height * .45);
    };
    draw(); timer = setInterval(draw, 30); stream = canvas.captureStream(30);
    audio = new AudioContext(); await audio.resume(); const destination = audio.createMediaStreamDestination(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); gain.gain.value = .01; oscillator.connect(gain).connect(destination); oscillator.start(); destination.stream.getAudioTracks().forEach(t => stream.addTrack(t));
    let complete;
    const finished = new Promise(resolve => complete = resolve);
    recorder = new Recorder(state => { if (['complete', 'error'].includes(state.status)) complete(state); });
    // Observe real decoder/canvas resources only during this start, restoring
    // the native factory even when preparation fails.
    const resources = [], createElement = document.createElement;
    try {
      document.createElement = function(tag, ...args) {
        const element = createElement.call(this, tag, ...args);
        if (['video', 'canvas'].includes(tag)) resources.push(element);
        return element;
      };
      await recorder.start(stream, { crop: { x: .5, y: 0, width: .5, height: 1 }, fps: 30, title: '自动检查 · 右半蓝色画面' });
    } finally { document.createElement = createElement; }
    const decoder = resources.find(element => element.tagName === 'VIDEO');
    const cropCanvas = resources.find(element => element.tagName === 'CANVAS');
    id = recorder.state.id;
    assert(recorder.state.status === 'recording', '真实 MediaRecorder 已启动');
    assert(recorder.state.pipeline === 'canvas', '框选使用裁切管线');
    await wait(1200); recorder.pause();
    assert(recorder.state.status === 'paused', '暂停状态正确');
    assert(decoder.paused && stream.active, '暂停裁切解码器，保留可继续的原始采集来源');
    const pausedFrames = recorder.videoOutput.getPerformance().canvas;
    await wait(600);
    const stillPaused = recorder.videoOutput.getPerformance().canvas;
    assert(stillPaused.drawnFrames === pausedFrames.drawnFrames && stillPaused.frameCallbacks === pausedFrames.frameCallbacks,
      '暂停期间没有裁切绘制或视频帧回调递归');
    recorder.resume(); await wait(1200);
    assert(!decoder.paused && recorder.videoOutput.getPerformance().canvas.drawnFrames > pausedFrames.drawnFrames,
      '继续后实际解码与裁切恢复');
    recorder.stop();
    const final = await Promise.race([finished, wait(10000).then(() => { throw new Error('保存超时'); })]);
    assert(final.status === 'complete' && !final.error, '视频片段写入并完成保存');
    const stored = await getRecording(id);
    assert(stored.width === 320 && stored.height === 360, '输出仅包含选定的右半画面');
    assert(stored.duration > 2000 && stored.duration < 2900, '视频计时排除 600ms 暂停');
    assert(stored.bytes > 1000, 'IndexedDB 已持久保存真实视频数据');
    assert(stored.performance?.video?.canvas?.drawnFrames > 0 && stored.performance.video.canvas.drawSubmitMsTotal >= 0,
      '裁切绘制帧数及提交耗时已写入诊断');
    assert(stored.performance.storage.chunkWritesCompleted === stored.performance.storage.chunksReceived && stored.performance.storage.chunkWriteMsTotal >= 0,
      '片段写入耗时与完成数量已落盘');
    assert(stored.performance.audio.mode === 'direct', '单一路来源音轨直接编码，不经过额外混音');
    assert(recorder.streams.length === 0, '结束后释放视频和音频来源');
    assert(decoder.paused && decoder.srcObject === null && cropCanvas.width === 0 && cropCanvas.height === 0,
      '结束后断开解码来源并归零裁切画布，立即释放像素缓冲');
    const blob = await recordingBlob(id);
    assert(blob.size === stored.bytes, '合并后的视频大小与落盘片段一致');
    const video = document.getElementById('playback'); video.muted = true; previewUrl = URL.createObjectURL(blob); video.src = previewUrl;
    await video.play(); await wait(400);
    const test = document.createElement('canvas'); test.width = 320; test.height = 360;
    const t = test.getContext('2d'); t.drawImage(video, 0, 0); const pixel = t.getImageData(20, 20, 1, 1).data;
    assert(pixel[2] > 180 && pixel[0] < 50, '解码成片确认裁切区域为蓝色，不含左半红色');
    video.pause();
    assert(video.captureStream().getAudioTracks().length > 0, '成片包含声音轨道');
    await deleteRecording(id); id = null;
    stream = canvas.captureStream(30);
    const mutedDestination = audio.createMediaStreamDestination(); oscillator.connect(mutedDestination);
    mutedDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    let directComplete;
    const directFinished = new Promise(resolve => directComplete = resolve);
    recorder = new Recorder(state => { if (['complete', 'error'].includes(state.status)) directComplete(state); });
    await recorder.start(stream, { fps: 30, quality: '720', audio: false, title: '自动检查 · 完整画面直接录制' });
    id = recorder.state.id;
    assert(recorder.state.pipeline === 'direct', '完整画面直接编码原始轨道，省去逐帧画布复制');
    await wait(1200); recorder.stop();
    const directFinal = await Promise.race([directFinished, wait(10000).then(() => { throw new Error('直接录制保存超时'); })]);
    assert(directFinal.status === 'complete' && !directFinal.error, '直接录制完成保存');
    const directStored = await getRecording(id);
    assert(directStored.width === 640 && directStored.height === 360 && directStored.bytes > 1000, '直接录制尺寸及持久化数据正确');
    assert(directStored.performance?.video?.pipeline === 'direct' && !directStored.performance.video.canvas && directStored.performance.video.settingsAreNotMeasuredFps,
      '完整画面诊断仅报告来源设置，没有为测FPS新增画布管线');
    URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await recordingBlob(id)); video.src = previewUrl;
    await video.play(); await wait(400);
    test.width = 640; t.drawImage(video, 0, 0);
    const left = t.getImageData(20, 20, 1, 1).data, right = t.getImageData(600, 20, 1, 1).data;
    assert(left[0] > 180 && right[2] > 180, '直接录制成片可解码，完整保留左右画面');
    assert(video.captureStream().getAudioTracks().length === 0, '关闭来源声音后，实际带音源的来源也不会写入音轨');
    video.pause();
    assert(recorder.streams.length === 0 && !stream.active, '直接录制结束后释放来源');
    await deleteRecording(id); id = null;
    canvas.width = 1280; canvas.height = 720; draw(); stream = canvas.captureStream(30);
    let dpiComplete;
    const dpiFinished = new Promise(resolve => { dpiComplete = resolve; });
    recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) dpiComplete(state); });
    await recorder.start(stream, { crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 640, viewportHeight: 362 },
      fps: 30, audio: false, title: '自动检查 · 高DPI的CSS容差' });
    id = recorder.state.id;
    assert(recorder.state.status === 'recording', '实际2倍像素采集与视口相差2 CSS像素仍可启动区域录制');
    await wait(1100); recorder.stop();
    const dpiFinal = await Promise.race([dpiFinished, wait(10000).then(() => { throw new Error('高DPI样片保存超时'); })]);
    assert(dpiFinal.status === 'complete' && !dpiFinal.error, '高DPI区域样片实际完成编码与保存');
    URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await recordingBlob(id)); video.src = previewUrl;
    await video.play(); await wait(250); test.width = 640; test.height = 720; t.drawImage(video, 0, 0);
    const dpiPixel = t.getImageData(20, 20, 1, 1).data;
    assert(video.videoWidth === 640 && video.videoHeight === 720 && dpiPixel[2] > 180 && dpiPixel[0] < 50,
      '高DPI成片解码仍只含右半蓝色，尺寸正确');
    video.pause(); await deleteRecording(id); id = null; canvas.width = 640; canvas.height = 360; draw();
    for (const box of [
      { label: '左右补边', x: 80, y: 0, width: 480, height: 360 },
      { label: '上下补边', x: 0, y: 20, width: 640, height: 320 }
    ]) {
      boxedCase = box; draw(); stream = canvas.captureStream(30);
      let finishBox;
      const boxFinished = new Promise(resolve => { finishBox = resolve; });
      recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) finishBox(state); });
      await recorder.start(stream, { captureLayout: 'chrome-tab', audio: false, fps: 30,
        crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: box.width, viewportHeight: box.height }, title: `自动检查 · Chrome固定帧${box.label}` });
      id = recorder.state.id;
      assert(recorder.state.status === 'recording', `${box.label}固定帧无需匹配网页比例即可启动`);
      await wait(1100); recorder.stop();
      const boxFinal = await Promise.race([boxFinished, wait(10000).then(() => { throw new Error('固定帧样片保存超时'); })]);
      assert(boxFinal.status === 'complete', `${box.label}区域实际完成编码和落盘`);
      const boxStored = await getRecording(id), rect = boxStored.performance?.video?.canvas?.contentRect;
      assert(rect?.x === box.x && rect.y === box.y && rect.width === box.width && rect.height === box.height &&
        boxStored.width === box.width / 2 && boxStored.height === box.height, `${box.label}内容偏移、裁切和输出尺寸正确`);
      URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await recordingBlob(id)); video.src = previewUrl;
      await video.play(); await wait(250); test.width = box.width / 2; test.height = box.height; t.drawImage(video, 0, 0);
      const topPixel = t.getImageData(5, 5, 1, 1).data, bottomPixel = t.getImageData(test.width - 6, test.height - 6, 1, 1).data;
      assert(video.videoWidth === box.width / 2 && video.videoHeight === box.height &&
        topPixel[2] > 180 && topPixel[0] < 50 && bottomPixel[2] > 180 && bottomPixel[0] < 50,
        `${box.label}解码成片两端均为选定蓝色，没有黑边或左侧红色`);
      video.pause(); await deleteRecording(id); id = null;
    }
    boxedCase = { x: 80, y: 0, width: 480, height: 360 }; draw(); stream = canvas.captureStream(30);
    const fixedCrop = { x: .5, y: 0, width: .5, height: 1, viewportWidth: 480, viewportHeight: 360 };
    let finishFixed;
    const fixedFinished = new Promise(resolve => { finishFixed = resolve; });
    recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) finishFixed(state); });
    await recorder.start(stream, { captureLayout: 'chrome-tab', audio: false, fps: 30, crop: fixedCrop, title: '自动检查 · 固定区域持续录制' });
    id = recorder.state.id;
    await wait(650); recorder.pause();
    Object.assign(fixedCrop, { x: 0, width: 1, viewportWidth: 720, viewportHeight: 720 });
    canvas.width = 720; canvas.height = 720; boxedCase = { x: 0, y: 90, width: 720, height: 540 }; draw();
    await wait(300);
    assert(recorder.state.status === 'paused', '设置对象改变和采集容器比例变化后，暂停状态正常且未误停');
    recorder.resume(); await wait(650);
    const fixedPerf = recorder.videoOutput.getPerformance();
    assert(recorder.state.status === 'recording' && !recorder.state.error && fixedPerf.canvas.sourceResolutionChanges >= 1,
      '继续录制后自动适配新采集容器，不报网页尺寸变化');
    assert(recorder.videoOutput.width === 240 && recorder.videoOutput.height === 360 && fixedPerf.canvas.cropRect.x === 360 &&
      fixedPerf.canvas.cropRect.y === 90 && fixedPerf.canvas.cropRect.width === 360 && fixedPerf.canvas.cropRect.height === 540,
      '原选区快照独立，仍映射首次选定的右半范围，输出尺寸不变');
    const fixedPreview = document.createElement('video'); fixedPreview.muted = true; fixedPreview.srcObject = recorder.videoOutput.stream;
    try {
      await fixedPreview.play(); await wait(150); test.width = 240; test.height = 360; t.drawImage(fixedPreview, 0, 0);
      const first = t.getImageData(5, 5, 1, 1).data, last = t.getImageData(234, 354, 1, 1).data;
      assert(first[2] > 180 && first[0] < 50 && last[2] > 180 && last[0] < 50,
        '暂停继续及容器变化后的实际裁切轨道两端仍为选定蓝色');
    } finally { fixedPreview.pause(); fixedPreview.srcObject = null; }
    recorder.stop();
    const fixedFinal = await Promise.race([fixedFinished, wait(10000).then(() => { throw new Error('固定区域样片保存超时'); })]);
    assert(fixedFinal.status === 'complete' && (await getRecording(id)).bytes > 0, '固定区域持续录制完成保存，无尺寸误报');
    URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await recordingBlob(id)); video.src = previewUrl;
    await video.play(); await wait(250); t.drawImage(video, 0, 0);
    const fixedPixel = t.getImageData(5, 5, 1, 1).data;
    assert(video.videoWidth === 240 && video.videoHeight === 360 && fixedPixel[2] > 180 && fixedPixel[0] < 50,
      '固定区域成片可解码，保留原选区与输出尺寸');
    video.pause(); await deleteRecording(id); id = null;
    canvas.width = 640; canvas.height = 360; boxedCase = null; draw();
    stream = canvas.captureStream(30);
    let finishLowLoad;
    const lowLoadFinished = new Promise(resolve => { finishLowLoad = resolve; });
    recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) finishLowLoad(state); });
    await recorder.start(stream, { crop: { x: .5, y: 0, width: .5, height: 1 }, quality: 'performance', fps: 20, audio: false, title: '自动检查 · 低负载20FPS' });
    id = recorder.state.id;
    assert(recorder.state.status === 'recording' && recorder.videoOutput.getPerformance().requestedFrameRate === 20,
      '低负载区域录制实际启动，裁切目标为20FPS');
    const lowLoadStarted = performance.now(); await wait(1200);
    const lowLoadFrames = recorder.videoOutput.getPerformance().canvas.drawnFrames;
    assert(lowLoadFrames >= 3 && lowLoadFrames <= Math.ceil((performance.now() - lowLoadStarted) * .02) + 2,
      '实际浏览器裁切绘制不超过20FPS目标，没有恢复为30FPS');
    recorder.stop();
    const lowLoadFinal = await Promise.race([lowLoadFinished, wait(10000).then(() => { throw new Error('低负载样片保存超时'); })]);
    const lowLoadStored = await getRecording(id);
    assert(lowLoadFinal.status === 'complete' && lowLoadStored.fps === 20 && lowLoadStored.width === 320 && lowLoadStored.height === 360 && lowLoadStored.bytes > 0,
      '20FPS样片实际编码与分段保存，选区和输出尺寸正确');
    URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await recordingBlob(id)); video.src = previewUrl;
    await video.play(); await wait(250); test.width = 320; test.height = 360; t.drawImage(video, 0, 0);
    const lowLoadPixel = t.getImageData(5, 5, 1, 1).data;
    assert(video.videoWidth === 320 && video.videoHeight === 360 && lowLoadPixel[2] > 180 && lowLoadPixel[0] < 50,
      '低负载成片可解码且保留固定右半蓝色区域');
    video.pause(); await deleteRecording(id); id = null;
    let resolveSource;
    recorder = new Recorder();
    const cancelledStart = recorder.start(() => new Promise(resolve => { resolveSource = resolve; })).catch(error => error);
    recorder.stop();
    const cancelled = await cancelledStart;
    stream = canvas.captureStream(30); resolveSource(stream); await wait(20);
    assert(cancelled.name === 'AbortError' && recorder.state.status === 'cancelled' && !stream.active, '准备期间取消成功，迟到的真实媒体轨道已释放');
    stream = canvas.captureStream(30);
    let resizeComplete;
    const resizedFinished = new Promise(resolve => { resizeComplete = resolve; });
    recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) resizeComplete(state); });
    await recorder.start(stream, { crop: { x: .5, y: 0, width: .5, height: 1 }, fps: 30, title: '自动检查 · 范围变化安全停止' });
    id = recorder.state.id;
    await wait(1200); canvas.width = 320; canvas.height = 180; draw(); await wait(600);
    assert(recorder.state.status === 'recording', '来源等比例降低分辨率后区域录制继续，不误报网页尺寸变化');
    assert(recorder.videoOutput.getPerformance().canvas.sourceResolutionChanges >= 1 && recorder.videoOutput.width === 320 && recorder.videoOutput.height === 360,
      '采集像素变化重新映射选区，编码输出尺寸保持固定');
    const current = recorder.videoOutput.stream;
    const cropPreview = document.createElement('video'); cropPreview.muted = true; cropPreview.srcObject = current;
    try {
      await cropPreview.play(); await wait(150); test.width = 320; test.height = 360; t.drawImage(cropPreview, 0, 0);
      const remapped = t.getImageData(20, 20, 1, 1).data;
      assert(remapped[2] > 180 && remapped[0] < 50, '实际裁切轨道重映射后仍为右半蓝色，没有录入左半红色');
    } finally { cropPreview.pause(); cropPreview.srcObject = null; }
    canvas.width = 800;
    const resizedFinal = await Promise.race([resizedFinished, wait(10000).then(() => { throw new Error('尺寸变化后未停止'); })]);
    assert(resizedFinal.status === 'interrupted' && /重新框选/.test(resizedFinal.error), '来源像素尺寸变化会停止保存，提示重新框选');
    assert(!stream.active && (await getRecording(id)).bytes > 0, '尺寸变化后来源已释放，已有片段仍保留');
    await deleteRecording(id); id = null; canvas.width = 640; canvas.height = 360;
    result.textContent += '\n全部通过。测试录制已清理，播放器保留临时预览。';
  } catch (e) { result.textContent += `\nFAIL ${e.stack || e.message}`; recorder?.stop(); }
  finally { clearInterval(timer); stream?.getTracks().forEach(t => t.stop()); audio?.close(); canvas.width = 640; canvas.height = 360; button.disabled = false; }
};
