import { Recorder } from '../lib/recorder.js';
import { getRecording, recordingBlob, deleteRecording } from '../lib/db.js';
import { isRecordingFormatSupported, chooseRecordingMime } from '../lib/media-format.js';
import { prepareRecordingExport } from '../lib/export.js';
import { convertToMp4 } from '../lib/mp4.js';
const button = document.getElementById('run'), result = document.getElementById('result'), canvas = document.getElementById('canvas');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let count = 0;
function ok(condition, label) { if (!condition) throw new Error(label); result.textContent += `\nPASS ${label}`; count++; }
async function until(check, timeout = 20000) { const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error('等待结果超时'); await sleep(30); } }
async function ftyp(blob) { const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer()); return String.fromCharCode(...bytes.slice(4, 8)); }
function link(blob, label, filename) { const a = document.createElement('a'); a.textContent = label; a.download = filename; a.href = URL.createObjectURL(blob); document.getElementById('downloads').append(a); }
async function decoded(blob, width = 320, height = 180) {
  const video = document.createElement('video'); video.muted = true; video.controls = true; const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('解码输出失败')); video.src = url; });
  ok(video.videoWidth === width && video.videoHeight === height, 'MP4 输出能够真实解码，尺寸正确');
  const stream = video.captureStream(); await video.play(); await sleep(200);
  ok(stream.getAudioTracks().length > 0, 'MP4 输出保留音轨');
  stream.getTracks().forEach(track => track.stop()); video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url);
}
button.onclick = async () => {
  button.disabled = true; result.textContent = '运行中…'; count = 0;
  const ids = []; let timer, audio, source, native, region, webm, prepared, converted;
  try {
    const supported = isRecordingFormatSupported('mp4');
    result.textContent += `\n浏览器能力：${supported ? chooseRecordingMime('mp4') : '不支持 H.264/AAC MP4'}`;
    if (!supported) { result.textContent += '\nSKIP 当前浏览器缺少原生 MP4 编码；界面应禁用 MP4，保留 WebM。'; return; }
    const ctx = canvas.getContext('2d'); let n = 0;
    const draw = () => { ctx.fillStyle = '#123b35'; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = '#80dda8'; ctx.fillRect(n++ % 260, 60, 50, 50); ctx.fillStyle = '#fff'; ctx.fillText(`MP4 frame ${n}`, 12, 25); };
    draw(); timer = setInterval(draw, 33);
    audio = new AudioContext(); await audio.resume(); const destination = audio.createMediaStreamDestination(), tone = audio.createOscillator(); tone.frequency.value = 440; const gain = audio.createGain(); gain.gain.value = .08; tone.connect(gain).connect(destination); tone.start();
    const create = () => { const s = canvas.captureStream(30); s.addTrack(destination.stream.getAudioTracks()[0].clone()); return s; };
    source = create(); native = new Recorder(); await native.start(source, { format: 'mp4', audio: true, quality: '720', fps: 30 }); ids.push(native.state.id);
    await sleep(1800); native.stop(); await until(() => ['complete', 'error', 'interrupted'].includes(native.state.status));
    ok(native.state.status === 'complete', `原生 MP4 分段录制完成：${native.state.status} ${native.state.error || ''}`);
    const nativeRecord = await getRecording(native.state.id); const nativeBlob = await recordingBlob(nativeRecord.id);
    ok(nativeRecord.format === 'mp4' && nativeRecord.mimeType.startsWith('video/mp4'), '数据库记录实际 MP4 容器');
    ok(await ftyp(nativeBlob) === 'ftyp', '原生文件具有真实 MP4 ftyp 标识'); await decoded(nativeBlob); link(nativeBlob, '下载原生 MP4 样片', 'yinglu-native.mp4');
    source = create(); region = new Recorder();
    await region.start(source, { format: 'mp4', audio: true, quality: 'performance', fps: 20,
      crop: { x: .5, y: 0, width: .5, height: 1, viewportWidth: 320, viewportHeight: 180 } }); ids.push(region.state.id);
    await sleep(1300); region.stop(); await until(() => ['complete', 'error', 'interrupted'].includes(region.state.status));
    ok(region.state.status === 'complete' && region.state.pipeline === 'canvas', '低负载区域 MP4 使用确认后的视口完成真实裁切录制');
    ok((await getRecording(region.state.id)).fps === 20 && region.videoPerformance.requestedFrameRate === 20, '20FPS低负载设置贯通原生MP4区域录制与保存元数据');
    const regionBlob = await recordingBlob(region.state.id);
    ok(await ftyp(regionBlob) === 'ftyp', '区域成片仍为真实 MP4 容器'); await decoded(regionBlob, 160, 180);
    link(regionBlob, '下载低负载区域 MP4 样片', 'yinglu-region-0.4.7.mp4');
    source = create(); webm = new Recorder(); await webm.start(source, { format: 'webm', audio: true, quality: '720', fps: 30 }); ids.push(webm.state.id);
    await sleep(2200); webm.stop(); await until(() => ['complete', 'error', 'interrupted'].includes(webm.state.status)); ok(webm.state.status === 'complete', '待转换 WebM 已分段保存');
    const webmRecord = await getRecording(webm.state.id); prepared = await prepareRecordingExport(webmRecord.id);
    let progress = 0;
    converted = await prepareRecordingExport(webmRecord.id, { format: 'mp4', onProgress: () => progress++ });
    ok(converted.format === 'mp4' && converted.filename.endsWith('.mp4'), '录制库导出接口完成真实转换并使用 MP4 文件名');
    const convertedBlob = await (await fetch(converted.url)).blob();
    ok(await ftyp(convertedBlob) === 'ftyp', 'WebM 转换结果为真实 MP4'); ok(progress > 0, '转换期间提供进度'); await decoded(convertedBlob); link(convertedBlob, '下载转换 MP4 样片', 'yinglu-converted.mp4');
    ok((await getRecording(webmRecord.id)).mimeType.startsWith('video/webm'), '转换不修改 WebM 原件');
    const controller = new AbortController();
    const cancelled = convertToMp4(prepared.url, webmRecord, { signal: controller.signal, onProgress: () => { setTimeout(() => controller.abort(), 100); } });
    await cancelled.then(() => { throw new Error('取消没有生效'); }, error => ok(error.name === 'AbortError', '转换可取消并释放资源'));
    ok((await recordingBlob(webmRecord.id)).size === webmRecord.bytes, '取消转换后原片完整保留');
    result.textContent += `\n全部通过（${count} 项）。样片可下载核验实际编码。`;
  } catch (error) { result.textContent += `\nFAIL ${error.stack || error.message}`; }
  finally {
    clearInterval(timer); source?.getTracks().forEach(track => track.stop()); await audio?.close().catch(() => {});
    await converted?.cleanup().catch(() => {}); await prepared?.cleanup().catch(() => {});
    for (const id of ids) await deleteRecording(id).catch(() => {}); button.disabled = false;
  }
};
