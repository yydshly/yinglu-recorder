import { prepareImageMaterial, imageBlobToDataURL } from './image-annotation.js';
import { MATERIAL_LIMIT, listImageMaterials, saveImageMaterial, getImageMaterial, deleteImageMaterial } from './image-materials.js';

export function createMaterialShelf({ canImport, canUse, captureDestination, insert, onBusy, onError }) {
  let imageController;
  const $ = id => document.getElementById(id), rows = new Map();
  let records = [], busy = false, disposed = false, revision = 0, loaded = false, changedWhileBusy = false;
  let dirty = true, refreshing;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('yinglu-image-materials') : null;
  const status = value => { $('material-status').textContent = value; };
  const expanded = () => $('materials-card').open && !document.hidden;
  function releaseRows() {
    for (const { element, url } of rows.values()) { element.remove(); URL.revokeObjectURL(url); }
    rows.clear(); records = []; loaded = false;
  }
  function render() {
    $('prepare-materials').disabled = disposed || busy || !loaded || !canImport() || records.length >= MATERIAL_LIMIT;
    $('material-retry').disabled = disposed || busy;
    for (const { use, remove } of rows.values()) { use.disabled = disposed || busy || !canUse(); remove.disabled = disposed || busy; }
  }
  function setBusy(value) {
    busy = value; onBusy(value); render();
    if (!busy && !expanded()) { ++revision; dirty = true; releaseRows(); }
    if (!busy && changedWhileBusy && expanded()) { changedWhileBusy = false; refresh().catch(() => {}); }
  }
  function summary() {
    status(records.length ? `${records.length} / ${MATERIAL_LIMIT} 张 · ${(records.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(1)} / 16 MB · 点击图片使用` : '录制前备好参数图或截图，录制时点击使用。');
  }
  function refresh() {
    if (disposed || !expanded()) { dirty = true; return Promise.resolve(); }
    if (refreshing) { changedWhileBusy = true; return refreshing; }
    refreshing = readMaterials().finally(() => {
      refreshing = null;
      if (changedWhileBusy && !busy && expanded() && !disposed) { changedWhileBusy = false; refresh().catch(() => {}); }
    });
    return refreshing;
  }
  async function readMaterials() {
    const attempt = ++revision;
    try {
      const next = await listImageMaterials();
      if (disposed || attempt !== revision) return;
      records = next; loaded = true; dirty = false; $('material-retry').hidden = true;
      const ids = new Set(next.map(item => item.id));
      for (const [id, row] of rows) if (!ids.has(id)) { row.element.remove(); URL.revokeObjectURL(row.url); rows.delete(id); }
      for (const record of next) if (!rows.has(record.id)) {
        const element = document.createElement('div'); element.className = 'material-item';
        const use = document.createElement('button'); use.className = 'material-use'; use.type = 'button';
        use.title = `使用 ${record.name}`; use.setAttribute('aria-label', `使用素材 ${record.name}`);
        const image = document.createElement('img'), url = URL.createObjectURL(record.thumbnail);
        image.src = url; image.alt = ''; image.width = 96; image.height = 64; image.loading = 'lazy'; image.decoding = 'async';
        const label = document.createElement('span'); label.textContent = record.name;
        use.append(image, label); use.onclick = () => useMaterial(record.id);
        const remove = document.createElement('button'); remove.className = 'material-remove'; remove.type = 'button'; remove.textContent = '×';
        remove.title = '移除备选素材，网页中已插入的图片保留'; remove.setAttribute('aria-label', `移除素材 ${record.name}`);
        remove.onclick = () => removeMaterial(record.id);
        element.append(use, remove); rows.set(record.id, { element, use, remove, url }); $('material-list').append(element);
      }
      $('material-list').hidden = !next.length;
      if (!busy) summary(); render();
    } catch (error) {
      if (disposed || attempt !== revision) return;
      status('素材暂未加载，可重试；录制和临时添加图片仍可使用。'); $('material-retry').hidden = false; render();
      throw error;
    }
  }
  async function useMaterial(id) {
    if (busy || disposed || !canUse()) return;
    const destination = captureDestination(); setBusy(true); imageController = new AbortController();
    try {
      // Read one already-prepared image only. Thumbnails never retain full
      // decoded rasters, and recording clicks do not rescale or recompress it.
      const blob = await getImageMaterial(id);
      if (!blob) throw new Error('这张素材已被移除，请选择其他图片。');
      const src = await imageBlobToDataURL(blob, { signal: imageController.signal });
      if (disposed) return;
      await insert({ src }, destination);
    } catch (error) { if (!disposed) onError(error); }
    finally { if (!disposed) { setBusy(false); summary(); } }
  }
  async function removeMaterial(id) {
    if (busy || disposed) return;
    setBusy(true);
    try { await deleteImageMaterial(id); channel?.postMessage('changed'); await refresh(); }
    catch (error) { if (!disposed) onError(error); }
    finally { if (!disposed) { setBusy(false); summary(); } }
  }
  $('prepare-materials').onclick = () => {
    if ($('prepare-materials').disabled) return;
    $('material-files').value = ''; $('material-files').click();
  };
  $('material-files').onchange = async () => {
    const files = Array.from($('material-files').files || []);
    $('material-files').value = '';
    if (!files.length || busy || disposed || !canImport()) return;
    setBusy(true);
    imageController = new AbortController();
    let added = 0, skipped = 0, firstError;
    try {
      const remaining = Math.max(0, MATERIAL_LIMIT - records.length);
      skipped = Math.max(0, files.length - remaining);
      for (const [index, file] of files.slice(0, remaining).entries()) {
        if (disposed || !canImport()) { firstError ||= new Error('录制或网页操作已开始，本次素材准备已停止。'); break; }
        status(`正在准备 ${index + 1} / ${Math.min(files.length, remaining)}：${file.name}`);
        try {
          const prepared = await prepareImageMaterial(file, { signal: imageController.signal });
          if (disposed || !canImport()) { firstError ||= new Error('录制已开始，本次素材准备已停止。'); break; }
          await saveImageMaterial({ ...prepared, name: file.name }); added++;
        } catch (error) {
          firstError ||= error;
          // A stalled decoder must not create a batch of parallel decoders.
          if (/超时|存储|最多/.test(error.message)) break;
        }
      }
      if (added) channel?.postMessage('changed');
      await refresh();
    } catch (error) { firstError ||= error; }
    finally {
      if (!disposed) {
        setBusy(false);
        status(`已准备 ${added} 张${skipped ? `，超出数量的 ${skipped} 张未导入` : ''}${firstError ? `；${firstError.message}` : '，点击缩略图即可使用。'}`);
      }
    }
  };
  $('material-retry').onclick = () => refresh().catch(onError);
  const visible = () => {
    if (expanded() && !busy && (dirty || !loaded)) refresh().catch(() => {});
    else if (!expanded() && !busy) { ++revision; dirty = true; releaseRows(); }
  };
  $('materials-card').addEventListener('toggle', visible);
  document.addEventListener('visibilitychange', visible);
  if (channel) channel.onmessage = () => {
    dirty = true;
    if (busy) changedWhileBusy = true;
    else if (expanded()) refresh().catch(() => {});
  };
  function dispose() {
    if (disposed) return;
    disposed = true; imageController?.abort(); ++revision; channel?.close(); document.removeEventListener('visibilitychange', visible);
    releaseRows();
  }
  window.addEventListener('pagehide', dispose, { once: true });
  if (expanded()) refresh().catch(() => {});
  render();
  return { render, refresh, dispose };
}
