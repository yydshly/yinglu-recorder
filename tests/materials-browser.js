import { prepareImageMaterial } from '../lib/image-annotation.js';
import { listImageMaterials, getImageMaterial, saveImageMaterial, deleteImageMaterial } from '../lib/image-materials.js';
const frame = document.getElementById('preview'), output = document.getElementById('result'), run = document.getElementById('run');
const owned = new Set(), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const start = Date.now(); while (!check()) { if (Date.now() - start > 15000) throw new Error('等待素材界面超时'); await wait(30); } }
async function trackNew(before) {
  const all = await listImageMaterials(); for (const item of all) if (!before.has(item.id)) owned.add(item.id); return all;
}
async function importFiles(panel, files) {
  const doc = panel.contentDocument, input = doc.getElementById('material-files');
  const originalClick = input.click; input.click = () => {};
  try { doc.getElementById('prepare-materials').click(); } finally { input.click = originalClick; }
  const transfer = new panel.contentWindow.DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new panel.contentWindow.Event('change'));
  await until(() => !doc.getElementById('prepare-materials').disabled && /已准备/.test(doc.getElementById('material-status').textContent));
}
document.getElementById('cleanup').onclick = async () => {
  for (const id of owned) await deleteImageMaterial(id);
  owned.clear(); const channel = new BroadcastChannel('yinglu-image-materials'); channel.postMessage('changed'); channel.close();
  output.textContent += '\n已清理本次创建的测试素材，原有素材与视频未改动。';
};
run.onclick = async () => {
  run.disabled = true; output.textContent = '运行中…'; let fills = [];
  const assert = (ok, label) => { if (!ok) throw new Error(label); output.textContent += `\nPASS ${label}`; };
  try {
    if (owned.size) throw new Error('请先清理本次测试素材，再重新运行。');
    await until(() => frame.contentDocument?.getElementById('panel')?.contentDocument?.getElementById('materials-card'));
    frame.contentDocument.getElementById('panel').contentDocument.getElementById('materials-card').open=true;
    await until(() => frame.contentDocument.getElementById('panel').contentDocument.getElementById('prepare-materials').disabled===false);
    const demo = frame.contentDocument, panel = demo.getElementById('panel');
    const original = await listImageMaterials(), before = new Set(original.map(item => item.id));
    if (original.length > 9) throw new Error('现有素材较多，请保留至少 3 个空位再测试；不会自动删除现有素材。');
    const token = crypto.randomUUID().slice(0, 6), blob = await (await fetch('annotation-sample.png')).blob();
    const first = new File([blob], `性能参数-${token}.png`, { type: 'image/png' });
    const card = document.createElement('canvas'); card.width = 720; card.height = 420;
    const ctx = card.getContext('2d'); ctx.fillStyle = '#203f35'; ctx.fillRect(0, 0, 720, 420); ctx.fillStyle = '#f4f5eb'; ctx.font = 'bold 34px system-ui'; ctx.fillText('低负载设置示例', 42, 76);
    ctx.font = '26px system-ui'; ctx.fillText('采集长边 1280', 42, 155); ctx.fillText('录制帧率 20 FPS', 42, 215); ctx.fillText('预先备好，演示时点用', 42, 275); ctx.font = '20px system-ui'; ctx.fillStyle = '#b7c6ae'; ctx.fillText('测试示例，并非项目实测性能', 42, 365);
    const secondBlob = await new Promise(resolve => card.toBlob(resolve));
    const second = new File([secondBlob], `低负载说明-${token}.png`, { type: 'image/png' });
    await importFiles(panel, [first, second]);
    const all = await trackNew(before), added = all.filter(item => owned.has(item.id));
    assert(added.length === 2 && !demo.querySelector('yinglu-overlay').shadowRoot.querySelector('canvas'), '批量准备两张图片，不立即显示在网页中');
    assert(added.every(item => !('blob' in item)) && (await getImageMaterial(added[0].id)).size > 0, '列表只读缩略图元数据，原图单独保存在本机');
    const thumbnail = await createImageBitmap(added[0].thumbnail);
    assert(Math.max(thumbnail.width, thumbnail.height) <= 192, '缩略图限制长边192，避免列表解码所有大图'); thumbnail.close();
    const previousDocument = panel.contentDocument;
    panel.contentWindow.location.reload();
    await until(() => panel.contentDocument !== previousDocument && panel.contentDocument?.getElementById('materials-card'));
    panel.contentDocument.getElementById('materials-card').open=true;
    await until(() => panel.contentDocument !== previousDocument && panel.contentDocument?.querySelectorAll('.material-use').length === all.length && panel.contentDocument?.getElementById('prepare-materials')?.disabled === false);
    assert(panel.contentDocument.querySelectorAll('.material-use').length === all.length, '侧栏重新加载后素材仍在，无需重选文件');
    const doc = panel.contentDocument, name = first.name;
    const shelf = doc.getElementById('material-list');
    assert(panel.contentWindow.getComputedStyle(shelf).display === 'grid' && shelf.children[0].getBoundingClientRect().width < shelf.getBoundingClientRect().width / 2,
      '素材使用紧凑缩略图网格，避免挤占录制控制区');
    [...doc.querySelectorAll('.material-use')].find(button => button.title === `使用 ${name}`).click();
    const root = demo.querySelector('yinglu-overlay').shadowRoot;
    await until(() => root.querySelector('canvas') && !doc.getElementById('add-image').disabled);
    assert(root.querySelector('canvas').width === 720 && doc.querySelector('[data-tool="select"]').getAttribute('aria-pressed') === 'true', '点击已备素材直接插入网页，并进入可移动缩放状态');
    doc.querySelector('[data-tool="pointer"]').click(); await until(() => root.querySelector('svg').style.pointerEvents === 'none');
    assert(!!root.querySelector('canvas'), '恢复操作网页后图片保留，可以继续演示');
    [...doc.querySelectorAll('.material-remove')].find(button => button.getAttribute('aria-label') === `移除素材 ${name}`).click();
    await until(() => doc.querySelectorAll('.material-use').length === all.length - 1 && !doc.getElementById('prepare-materials').disabled);
    assert(!await getImageMaterial(added.find(item => item.name === name).id) && !!root.querySelector('canvas'), '移除备选素材释放本机副本，已插入网页的图片保留');
    await importFiles(panel, [first]); await trackNew(before);
    const prepared = await prepareImageMaterial(second);
    let current = await listImageMaterials();
    while (current.length < 11) { const saved = await saveImageMaterial({ ...prepared, name: `容量测试-${token}` }); fills.push(saved.id); owned.add(saved.id); current.push(saved); }
    const competing = await Promise.allSettled([saveImageMaterial({ ...prepared, name: '最后名额-A' }), saveImageMaterial({ ...prepared, name: '最后名额-B' })]);
    for (const item of competing) if (item.status === 'fulfilled') { fills.push(item.value.id); owned.add(item.value.id); }
    assert(competing.filter(item => item.status === 'fulfilled').length === 1 && (await listImageMaterials()).length === 12, '真实 IndexedDB 并发导入不会突破12张容量上限');
    for (const id of fills) { await deleteImageMaterial(id); owned.delete(id); } fills = [];
    assert((await listImageMaterials()).length === original.length + 2, '临时容量测试素材已释放，保留两张演示素材');
    output.textContent += '\n\n全部通过（10项）。未进行真实 Chrome 标签页录制或性能测量。';
  } catch (error) { output.textContent += `\nFAIL ${error.stack || error.message}`; }
  finally { for (const id of fills) { await deleteImageMaterial(id); owned.delete(id); } run.disabled = false; }
};
