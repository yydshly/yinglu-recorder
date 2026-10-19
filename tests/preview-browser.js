import { Recorder } from '../lib/recorder.js';
import { getRecording, saveChunk, deleteRecording } from '../lib/db.js';
import { prepareRecordingPreview, cleanupPreviewFiles, PREVIEW_BLOB_LIMIT } from '../lib/preview.js';
const $ = id => document.getElementById(id), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > 15000) throw new Error('等待文件预览状态超时'); await wait(40); }
}
$('run').onclick = async () => {
  $('run').disabled = true; $('result').textContent = '运行中…';
  let recorder, stream, timer, id, directory, unblock, pendingPreview, directDirectory, directName, releaseDirectWrite, baseline = new Set(), passed = 0;
  const assert = (value, label) => { if (!value) throw new Error(label); passed++; $('result').textContent += `\nPASS ${label}`; };
  const names = async () => { const values = []; for await (const name of directory.keys()) if (!baseline.has(name)) values.push(name); return values; };
  try {
    directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('yinglu-previews', { create: true });
    for await (const name of directory.keys()) baseline.add(name);
    const canvas = $('source'), ctx = canvas.getContext('2d'); let frame = 0;
    const draw = () => { ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 160, 180); ctx.fillStyle = '#0000ff'; ctx.fillRect(160, 0, 160, 180); ctx.fillStyle = '#fff'; ctx.fillText(String(frame++), 220, 80); };
    draw(); timer = setInterval(draw, 50); stream = canvas.captureStream(20);
    let finished; const completion = new Promise(resolve => { finished = resolve; });
    recorder = new Recorder(state => { if (['complete', 'interrupted', 'error'].includes(state.status)) finished(state); });
    await recorder.start(stream, { crop: { x: .5, y: 0, width: .5, height: 1 }, fps: 20, audio: false,
      title: '合成预览检查：短片与32MiB格式填充' }); id = recorder.state.id;
    await wait(1400); recorder.stop(); const final = await completion;
    assert(final.status === 'complete' && !stream.active, '区域样片实际编码保存，停止后释放采集来源');
    let record = await getRecording(id);
    // An unknown-length Matroska Segment accepts a Void element at its end.
    // 0xEC + an eight-byte size VINT encodes a 32 MiB zero-filled payload.
    const padding = new Blob([new Uint8Array([0xEC, 0x01, 0, 0, 0, 2, 0, 0, 0]), new Uint8Array(PREVIEW_BLOB_LIMIT)]);
    record = { ...record, bytes: record.bytes + padding.size };
    await saveChunk(id, recorder.index, padding, record);
    assert(record.bytes > PREVIEW_BLOB_LIMIT, '真实IDB样片超过32MiB，走默认大文件分支，没有调低生产阈值');
    const iframe = $('library'); iframe.src = `../library.html?id=${encodeURIComponent(id)}`;
    await until(() => iframe.contentDocument?.getElementById('load-preview')?.hidden === false);
    const doc = iframe.contentDocument, load = doc.getElementById('load-preview'), release = doc.getElementById('close-preview'), player = doc.getElementById('player');
    assert(player.hidden && (await names()).length === 0, '打开长视频详情不自动创建缓存或载入完整视频');
    const loading = load.onclick(); await until(() => release.hidden === false); await release.onclick(); await loading;
    assert(player.hidden && !load.disabled && (await names()).length === 0 && doc.getElementById('error').hidden,
      '实际界面取消载入可恢复入口，未留下临时文件或错误');
    await load.onclick();
    assert(!player.hidden && /临时文件/.test(doc.getElementById('export-status').textContent), '生产录制库从OPFS文件载入预览');
    const cache = await names(); assert(cache.length === 1, '一次预览只持有一个独立临时文件');
    const file = await (await directory.getFileHandle(cache[0])).getFile();
    assert(file.size === record.bytes, '临时文件与IDB原片字节数一致，分段写入完整');
    player.muted = true; await until(() => player.readyState >= 2 && !player.seeking);
    await player.play(); await wait(150); player.pause();
    const check = document.createElement('canvas'); check.width = 160; check.height = 180;
    check.getContext('2d').drawImage(player, 0, 0); const pixel = check.getContext('2d').getImageData(10, 10, 1, 1).data;
    assert(player.videoWidth === 160 && player.videoHeight === 180 && pixel[2] > 180 && pixel[0] < 50, '文件URL实际解码保留选定蓝色区域，没有录入旁边红色');
    player.currentTime = .5; await until(() => !player.seeking && Math.abs(player.currentTime - .5) < .2);
    assert(player.readyState >= 2, '文件预览可定位播放时间');
    await cleanupPreviewFiles({ now: Date.now() + 2 * 86400000 });
    assert((await names()).includes(cache[0]), '真实Web Lock保护正在使用的缓存，跨页回收不会误删');
    await release.onclick();
    assert(player.hidden && !player.getAttribute('src') && (await names()).length === 0, '释放预览暂停播放器、断开URL并清除临时文件');
    assert((await getRecording(id)).bytes === record.bytes, '释放缓存保留原始分段视频');
    await load.onclick(); assert((await names()).length === 1, '释放后可以再次准备预览');
    const peer = new BroadcastChannel('yinglu-library-media');
    peer.postMessage({owner:'browser-peer'}); await until(async()=>(await names()).length===0); peer.close();
    assert(player.hidden && !load.disabled,'真实跨窗口广播释放旧回看，避免多个播放器并行占用');
    await load.onclick(); assert((await names()).length===1,'跨窗口释放后仍可重新载入');
    iframe.src = 'about:blank'; await until(async () => (await names()).length === 0);
    assert((await names()).length === 0, '关闭实际录制库页面后临时文件被回收');
    // Delay one native-file write through a test facade. IDB, file handles,
    // abort and cross-page Web Locks remain real; this is fault injection,
    // not a claim that the OS drive actually stalled.
    const controller = new AbortController(); let writeStarted = false;
    const gate = new Promise(resolve => { unblock = resolve; });
    const delayedDirectory = {
      entries: () => directory.entries(), removeEntry: name => directory.removeEntry(name),
      async getFileHandle(name,options) {
        const handle = await directory.getFileHandle(name,options);
        return {getFile:()=>handle.getFile(),async createWritable(){
          const writer = await handle.createWritable();
          return {async write(chunk){writeStarted=true;await gate;await writer.write(chunk);},close:()=>writer.close(),abort:()=>writer.abort()};
        }};
      }
    };
    pendingPreview = prepareRecordingPreview(id,{signal:controller.signal,cleanupTimeoutMs:20,
      storage:{getDirectory:async()=>({getDirectoryHandle:async()=>delayedDirectory})}}).then(value=>({value}),error=>({error}));
    await until(()=>writeStarted);controller.abort(); const cancelled=await pendingPreview;
    assert(cancelled.error?.name==='AbortError','故障注入：写入挂起时取消返回，不等待迟到写入');
    const pendingNames=await names();
    assert(pendingNames.length===1,'底层写入未结束时临时文件保持受保护，不提前宣告物理清理完成');
    await cleanupPreviewFiles({olderThanMs:0});
    assert((await names()).length===1,'取消后迟到写入仍受真实Web Lock保护，跨页清理跳过');
    let retryError;try{await prepareRecordingPreview(id);}catch(error){retryError=error;}
    assert(/上一段预览/.test(retryError?.message),'取消后原生写入未结束时不叠加另一份大文件准备');
    unblock(); await until(async()=>(await names()).length===0);
    assert((await getRecording(id)).bytes===record.bytes,'迟到写入结束后删除本次缓存并释放锁，原始视频不变');
    iframe.src = `../library.html?id=${encodeURIComponent(id)}`;
    await until(()=>iframe.contentDocument?.getElementById('export-file')?.onclick);
    const saveDoc=iframe.contentDocument,save=saveDoc.getElementById('export-file'),cancel=saveDoc.getElementById('cancel-export');
    directDirectory=await (await navigator.storage.getDirectory()).getDirectoryHandle('yinglu-browser-checks',{create:true});
    directName=`direct-${crypto.randomUUID()}.webm`;
    const directHandle=await directDirectory.getFileHandle(directName,{create:true});
    let started=false,lateSettled=false,pickers=0,aborts=0;
    const directGate=new Promise(resolve=>{releaseDirectWrite=resolve;});
    // Only the picker is simulated. The selected writer, IDB, copy, commit,
    // cancellation button and library lifecycle are production code/real OPFS.
    iframe.contentWindow.showSaveFilePicker=async()=>{pickers++;return{async createWritable(){
      const writer=await directHandle.createWritable();return{
        async write(chunk){started=true;try{await directGate;await writer.write(chunk);}finally{lateSettled=true;}},
        close:()=>writer.close(),abort:()=>{aborts++;return writer.abort();}
      };
    }}};
    const saving=save.onclick();await until(()=>started);
    assert(!cancel.hidden && cancel.textContent==='取消保存','生产直接保存显示取消入口，真实文件写入已开始');
    await cancel.onclick();await saving;
    assert(/已取消保存/.test(saveDoc.getElementById('export-status').textContent) && aborts===1 && (await getRecording(id)).bytes===record.bytes,
      '取消真实文件复制返回界面，主动abort并保留原始录制');
    await save.onclick();assert(pickers===1,'迟到写入结束前重复保存不再打开文件选择器或叠加写入');
    releaseDirectWrite();await until(()=>lateSettled);await wait(0);
    await save.onclick();
    assert(pickers===2 && (await directHandle.getFile()).size===record.bytes && /已保存/.test(saveDoc.getElementById('export-status').textContent),
      '迟到任务清理后可重试，完整分片真实提交至所选文件');
    $('result').textContent += `\n全部通过（${passed}项）。这是文件链路验证，不是长时录制或CPU/GPU基准。`;
  } catch (error) { $('result').textContent += `\nFAIL ${error.stack || error.message}`; }
  finally {
    releaseDirectWrite?.();
    unblock?.(); if (pendingPreview) await pendingPreview;
    clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); recorder?.stop();
    $('library').src = 'about:blank';
    if(directDirectory && directName) await directDirectory.removeEntry(directName).catch(()=>{});
    if (id) await deleteRecording(id); $('run').disabled = false;
  }
};
