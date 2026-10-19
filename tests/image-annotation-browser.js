import { prepareAnnotationImage, prepareImageMaterial } from '../lib/image-annotation.js';
import { Recorder } from '../lib/recorder.js';
import { getRecording, recordingBlob, deleteRecording } from '../lib/db.js';
const button = document.getElementById('run'), result = document.getElementById('result'), frame = document.getElementById('source');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, text) => { if (!ok) throw new Error(text); result.textContent += `\nPASS ${text}`; };
const green = pixel => pixel[1] > pixel[0] + 20 && pixel[1] > 60;
async function until(check) { const start = Date.now(); while (!check()) { if (Date.now() - start > 10000) throw new Error('等待图片标注超时'); await wait(30); } }
button.onclick = async () => {
  button.disabled = true; result.textContent = '运行中…';
  let api, recorder, id, timer, url, source;
  try {
    if (frame.contentDocument?.readyState !== 'complete') await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    api = frame.contentWindow.imageTest; await api.command('CLEAR');
    const blob = await (await fetch('annotation-sample.png')).blob();
    const image = await prepareAnnotationImage(new File([blob], 'sample.png', { type: 'image/png' }));
    assert(image.src.startsWith('data:image/png;base64,'), '本地参数图片经过真实解码和处理，保留PNG像素');
    const largeCanvas = document.createElement('canvas'); largeCanvas.width=4096; largeCanvas.height=2048;
    largeCanvas.getContext('2d').fillRect(0,0,4096,2048);
    const largeBlob = await new Promise(resolve=>largeCanvas.toBlob(resolve)); largeCanvas.width=largeCanvas.height=0;
    const preparedLarge = await prepareImageMaterial(new File([largeBlob],'large.png',{type:'image/png'}));
    assert(preparedLarge.width===1600 && preparedLarge.height===800 && preparedLarge.thumbnail.size<128*1024,'4096×2048真实PNG经预检与缩小解码，输出1600×800和小缩略图');
    const sampleCanvas=document.createElement('canvas'); sampleCanvas.width=40;sampleCanvas.height=20;
    sampleCanvas.getContext('2d').fillRect(0,0,20,20);
    const jpeg = await new Promise(resolve=>sampleCanvas.toBlob(resolve,'image/jpeg'));
    const bytes = new Uint8Array(await jpeg.arrayBuffer()),exif=new Uint8Array(36),exifView=new DataView(exif.buffer);
    exif.set([255,225,0,34,69,120,105,102,0,0,73,73]);exifView.setUint16(12,42,true);exifView.setUint32(14,8,true);
    exifView.setUint16(18,1,true);exifView.setUint16(20,0x112,true);exifView.setUint16(22,3,true);exifView.setUint32(24,1,true);exifView.setUint16(28,6,true);
    const rotated = await prepareImageMaterial(new File([bytes.slice(0,2),exif,bytes.slice(2)],'rotated.jpg',{type:'image/jpeg'}));
    assert(rotated.width===20 && rotated.height===40,'EXIF旋转JPEG在真实缩小解码后保持正确方向与比例');
    const webp = await new Promise(resolve=>sampleCanvas.toBlob(resolve,'image/webp'));
    const preparedWebp=await prepareImageMaterial(new File([webp],'sample.webp',{type:'image/webp'}));
    assert(preparedWebp.width===40 && preparedWebp.height===20,'浏览器生成的WebP文件头通过预检并真实解码');
    sampleCanvas.width=sampleCanvas.height=0;
    const oversized=new Uint8Array(33),header=new DataView(oversized.buffer);oversized.set([137,80,78,71,13,10,26,10]);header.setUint32(8,13);oversized.set([73,72,68,82],12);header.setUint32(16,20000);header.setUint32(20,20000);
    let refused;try{await prepareAnnotationImage(new File([oversized],'oversized.png',{type:'image/png'}));}catch(error){refused=error;}
    assert(/像素过大/.test(refused?.message),'仅33字节但声明4亿像素的PNG在原生解码前拒绝');
    await api.command('BEGIN', { sessionId: 'image-test', diagnostics: false, crop: { viewportWidth: 900, viewportHeight: 600 } });
    const region = { x: .2, y: .2, width: .7, height: .7, viewportWidth: 900, viewportHeight: 600 };
    const inserted = await api.command('INSERT_IMAGE', { image, region, sessionId: 'image-test' });
    const doc = frame.contentDocument, root = doc.querySelector('yinglu-overlay').shadowRoot, svg = root.querySelector('svg');
    const raster = svg.querySelector('canvas'), box = raster?.parentElement, group = box?.parentElement;
    assert(inserted.ok && raster.width === 720 && raster.height === 420, '图片实际成为网页中的标注对象');
    assert(green(raster.getContext('2d').getImageData(10, 50, 1, 1).data), 'img-src禁止图片加载的页面仍显示正确的本地图片像素');
    assert(Number(box.getAttribute('x')) >= 180 && Number(box.getAttribute('y')) >= 120 &&
      Number(box.getAttribute('x')) + Number(box.getAttribute('width')) <= 810 &&
      Number(box.getAttribute('y')) + Number(box.getAttribute('height')) <= 540, '区域录制时图片默认完整放在原选区内');
    for (const tool of ['pointer', 'rect', 'text', 'select']) await api.command('SET', { tool });
    assert(svg.querySelector('canvas') === raster && box.parentElement === group, '切换工具保留原图片像素和节点');
    await api.command('SET', { tool: 'text' });
    svg.dispatchEvent(new frame.contentWindow.PointerEvent('pointerdown', { button: 0, clientX: 420, clientY: 380, bubbles: true }));
    const editor = root.querySelector('textarea'); editor.value = '参数图也可以加文字说明'; editor.dispatchEvent(new frame.contentWindow.Event('blur'));
    await api.command('SET', { tool: 'pointer' });
    assert(root.querySelector('.annotation-text')?.textContent === '参数图也可以加文字说明' && svg.querySelector('canvas') === raster && svg.style.pointerEvents === 'none',
      '图片可叠加文字批注，恢复操作网页后标注仍显示');
    await api.command('UNDO'); await api.command('REDO'); await api.command('END');
    assert(!svg.querySelector('canvas'), '结束录制后图片随其他标注收起');
    const resources=(await api.command('PING',{resources:true})).resources;
    assert(resources.imageBytes===0 && resources.storedImageBytes>0 && raster.width===0,'录完归档释放画布像素，保留压缩原图用于恢复');
    await api.command('RESTORE');
    assert((await api.command('PING',{resources:true})).resources.imageBytes>0,'显示上次标注时才重新解码图片');
    assert(svg.querySelector('canvas') === raster && green(raster.getContext('2d').getImageData(10, 50, 1, 1).data), '撤销、重做与恢复使用同一份图片，像素仍正确');
    const alphaSource = document.createElement('canvas'); alphaSource.width = 40; alphaSource.height = 20;
    alphaSource.getContext('2d').fillRect(20, 0, 20, 20);
    const alphaBlob = await new Promise(resolve => alphaSource.toBlob(resolve));
    const alphaImage = await prepareAnnotationImage(new File([alphaBlob], 'transparent.png', { type: 'image/png' }));
    await api.command('INSERT_IMAGE', { image: alphaImage });
    const alphaRaster = [...svg.querySelectorAll('canvas')].at(-1);
    assert(alphaRaster.getContext('2d').getImageData(5, 5, 1, 1).data[3] === 0, '透明PNG导入后保留透明背景');
    await api.command('UNDO');
    // Encode the actual imported raster's pixels. This checks media output,
    // not Chrome tabCapture or the full page compositor.
    const movie = document.createElement('canvas'); movie.width = raster.width; movie.height = raster.height;
    const ctx = movie.getContext('2d'), draw = () => ctx.drawImage(raster, 0, 0); draw();
    source = movie.captureStream(20); timer = setInterval(draw, 50);
    let done;
    const finished = new Promise(resolve => { done = resolve; });
    recorder = new Recorder(state => { if (['complete', 'error', 'interrupted'].includes(state.status)) done(state); });
    await recorder.start(source, { fps: 20, audio: false, title: '自动检查 · 图片标注像素' }); id = recorder.state.id;
    await wait(1100); recorder.stop();
    const final = await Promise.race([finished, wait(10000).then(() => { throw new Error('图片样片保存超时'); })]);
    assert(final.status === 'complete' && (await getRecording(id)).bytes > 0, '导入图片的实际像素可编码并分段保存');
    const video = document.getElementById('playback'); video.muted = true;
    url = URL.createObjectURL(await recordingBlob(id));
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('图片样片无法解码')); video.src = url; });
    await video.play(); await wait(150); ctx.drawImage(video, 0, 0);
    assert(video.videoWidth === 720 && video.videoHeight === 420 && green(ctx.getImageData(10, 50, 1, 1).data), '成片可真实解码，图片像素和尺寸正确');
    video.pause(); video.removeAttribute('src'); video.load();
    const demo = document.getElementById('panel-flow');
    await until(() => demo.contentDocument?.querySelector('#panel')?.contentDocument?.getElementById('add-image')?.disabled === false);
    const demoDoc = demo.contentDocument, panel = demoDoc.getElementById('panel'), panelDoc = panel.contentDocument;
    const input = panelDoc.getElementById('image-file'), add = panelDoc.getElementById('add-image');
    const quality = panelDoc.getElementById('quality').value, fps = panelDoc.getElementById('fps').value;
    // Only the OS picker is simulated; production onchange, image processing,
    // postMessage routing, overlay decoding and rendering all run unchanged.
    const click = input.click; input.click = () => {};
    try { add.click(); } finally { input.click = click; }
    const transfer = new panel.contentWindow.DataTransfer();
    transfer.items.add(new panel.contentWindow.File([blob], 'sample.png', { type: 'image/png' }));
    input.files = transfer.files; input.dispatchEvent(new panel.contentWindow.Event('change'));
    const demoRoot = demoDoc.querySelector('yinglu-overlay').shadowRoot;
    await until(() => demoRoot.querySelector('canvas') && !add.disabled);
    assert(demoRoot.querySelector('canvas').width === 720 && !panelDoc.getElementById('error').textContent,
      '真实侧栏文件处理经消息联动，把参数图片添加到演示网页');
    assert(panelDoc.querySelector('[data-tool="select"]').getAttribute('aria-pressed') === 'true' && panelDoc.getElementById('quality').value === quality && panelDoc.getElementById('fps').value === fps,
      '导入后自动选中图片，保留原录制画质和帧率');
    panelDoc.querySelector('[data-tool="pointer"]').click();
    await until(() => demoRoot.querySelector('svg').style.pointerEvents === 'none');
    assert(demoRoot.querySelector('canvas')?.width === 720, '点击操作网页后图片保留，标注边框收起并恢复鼠标穿透');
    result.textContent += '\n全部通过（20项）。';
  } catch (error) { result.textContent += `\nFAIL ${error.stack || error.message}`; }
  finally {
    clearInterval(timer); recorder?.stop(); source?.getTracks().forEach(track => track.stop());
    if (id) await deleteRecording(id).catch(() => {}); if (url) URL.revokeObjectURL(url);
    await api?.command('END'); await api?.command('RESTORE'); button.disabled = false;
  }
};
