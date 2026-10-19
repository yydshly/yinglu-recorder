import { getRecording, patchRecording, saveRecording, saveChunk, recordingBlob, deleteRecording } from '../lib/db.js';
import { prepareRecordingExport } from '../lib/export.js';

const button = document.getElementById('run'), result = document.getElementById('result');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
async function temporaryFiles() {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('yinglu-exports');
    const names = [];
    for await (const name of directory.keys()) names.push(name);
    return { directory, names };
  } catch (error) {
    if (error.name === 'NotFoundError') return { names: [] };
    return null;
  }
}
async function unreadable(url) {
  try { await fetch(url); return false; } catch { return true; }
}

button.onclick = async () => {
  button.disabled = true; result.dataset.state = 'running'; result.textContent = '运行中…';
  let assertions = 0, recordingId, mediaRecorder, stream, timer, writes = Promise.resolve(), stopped;
  const resources = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    assertions++; result.textContent += `\nPASS ${message}`;
  };
  try {
    const canvas = document.getElementById('source'), context = canvas.getContext('2d');
    let frame = 0;
    const draw = () => {
      context.fillStyle = '#123c38'; context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#77e1ae'; context.fillRect(12 + frame++ % 240, 55, 48, 48);
      context.fillStyle = '#fff'; context.font = '16px sans-serif'; context.fillText(`映录自动保存测试 ${frame}`, 14, 30);
    };
    draw(); timer = setInterval(draw, 33); stream = canvas.captureStream(30);
    const mimeType = ['video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('此浏览器不支持 WebM 合成录制');
    mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 500000 });
    recordingId = `export-test-${crypto.randomUUID()}`;
    const recording = { id: recordingId, title: '自动保存字节检查', createdAt: Date.now(), mimeType: mediaRecorder.mimeType,
      width: 320, height: 180, fps: 30, bytes: 0, duration: 0, status: 'recording' };
    await saveRecording(recording);
    let index = 0, writeError;
    const originalChunks = [];
    mediaRecorder.ondataavailable = event => {
      if (!event.data.size) return;
      originalChunks.push(event.data); const chunkIndex = index++;
      writes = writes.then(async () => {
        const updated = { ...recording, bytes: recording.bytes + event.data.size };
        await saveChunk(recordingId, chunkIndex, event.data, updated);
        Object.assign(recording, updated);
      }).catch(error => { writeError = error; });
    };
    stopped = new Promise((resolve, reject) => {
      mediaRecorder.onstop = resolve; mediaRecorder.onerror = event => reject(event.error || new Error('合成视频编码失败'));
    });
    mediaRecorder.start(150); await wait(1600); mediaRecorder.stop(); await stopped; await writes;
    if (writeError) throw writeError;
    recording.status = 'complete'; recording.duration = 1600; await saveRecording(recording);
    stream.getTracks().forEach(track => track.stop()); clearInterval(timer);
    assert(originalChunks.length > 1 && recording.bytes > 0, '合成视频已分为多个片段，写入真实 IndexedDB');
    const expected = new Blob(originalChunks, { type: recording.mimeType }), expectedHash = await digest(expected);
    const stored = await getRecording(recordingId);
    assert(stored.status === 'complete' && stored.bytes === expected.size, '录制元数据大小与原始视频字节一致');

    await Promise.all([
      patchRecording(recordingId, { export: { status: 'queued' } }),
      patchRecording(recordingId, { title: '并发更新后的测试标题' })
    ]);
    const patched = await getRecording(recordingId);
    assert(patched.title === '并发更新后的测试标题' && patched.export.status === 'queued', '真实读写事务并发合并元数据，没有覆盖其他字段');
    assert(patched.bytes === stored.bytes && patched.status === 'complete' && patched.mimeType === stored.mimeType, '导出状态更新保留录制大小、格式和完成状态');
    const missingId = `missing-${crypto.randomUUID()}`;
    assert(await patchRecording(missingId, { export: { status: 'queued' } }) === undefined && await getRecording(missingId) === undefined, '不存在的录制不会被元数据更新重新创建');

    const before = await temporaryFiles();
    const prepared = await prepareRecordingExport(recordingId); resources.push(prepared);
    assert(['opfs', 'blob'].includes(prepared.storage), `自动保存准备成功，当前方式：${prepared.storage === 'opfs' ? 'OPFS 分段临时文件' : 'Blob 兼容模式'}`);
    const exported = await (await fetch(prepared.url)).blob();
    assert(exported.size === expected.size && await digest(exported) === expectedHash, '自动保存 URL 的完整字节与原始录制完全一致');
    assert((await fetch(prepared.url)).ok, '下载结束前，准备好的 URL 保持可读取');
    const after = await temporaryFiles();
    let createdName;
    if (prepared.storage === 'opfs' && before && after) {
      const created = after.names.filter(name => !before.names.includes(name)); createdName = created[0];
      assert(created.length === 1 && createdName.startsWith('auto-'), 'OPFS 只新增一个自动保存临时文件');
    }
    await prepared.cleanup(); await prepared.cleanup();
    assert(await unreadable(prepared.url), '结束清理会撤销 URL，重复清理可安全执行');
    if (createdName) {
      let missing = false;
      try { await after.directory.getFileHandle(createdName); } catch (error) { missing = error.name === 'NotFoundError'; }
      assert(missing, '结束清理已删除真实 OPFS 临时文件');
    }
    assert(await digest(await recordingBlob(recordingId)) === expectedHash, '清理导出临时资源后，IndexedDB 原始视频副本仍完整保留');

    const fallback = await prepareRecordingExport(recordingId, { storage: {} }); resources.push(fallback);
    assert(fallback.storage === 'blob', '不支持 OPFS 时明确使用 Blob 兼容方式');
    assert(await digest(await (await fetch(fallback.url)).blob()) === expectedHash, 'Blob 兼容方式导出的字节也与原始录制一致');
    await fallback.cleanup(); assert(await unreadable(fallback.url), 'Blob 兼容方式结束后也正确撤销 URL');
    assert((await getRecording(recordingId)).export.status === 'queued', '准备或清理下载资源不会改写录制元数据');
    result.textContent += `\n全部通过（${assertions} 项）。测试录制和导出临时文件已清理。`;
    result.dataset.state = 'passed';
  } catch (error) {
    result.dataset.state = 'failed'; result.textContent += `\nFAIL ${error.stack || error.message}`;
  } finally {
    clearInterval(timer);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    await stopped?.catch(() => {}); await writes.catch(() => {});
    stream?.getTracks().forEach(track => track.stop());
    for (const resource of resources) await resource.cleanup().catch(() => {});
    if (recordingId) await deleteRecording(recordingId).catch(() => {});
    button.disabled = false;
  }
};
