const result = document.getElementById('result'), frame = document.getElementById('source');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = frame.contentDocument?.readyState === 'complete' ? Promise.resolve() : new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
const assert = (ok, text) => { if (!ok) throw new Error(text); result.textContent += `\nPASS ${text}`; };
document.getElementById('run').onclick = async () => {
  const button = document.getElementById('run'); button.disabled = true; result.textContent = '运行中…';
  let api;
  try {
    await ready; api = frame.contentWindow.viewportTest;
    await api.command('BEGIN', { sessionId: 'first', crop: { viewportWidth: 800, viewportHeight: 600 }, deferViewport: true, diagnostics: false });
    frame.style.height = '560px'; await wait(150);
    const resized = () => api.events.filter(event => event.type === 'VIEWPORT_RESIZE');
    assert(resized().length === 0, '真实网页高度在采集启动期缩小，不误触发停止');
    const viewport = await api.command('CAPTURE_VIEWPORT', { sessionId: 'first' });
    assert(viewport.ok && viewport.width === 800 && viewport.height === 560, '握手等待浏览器布局稳定并返回实际视口');
    const armed = await api.command('ARM_VIEWPORT', { sessionId: 'first', crop: { viewportWidth: 800, viewportHeight: 560 } });
    assert(armed.ok, '以确认后的实际尺寸启用录制期保护');
    const win = frame.contentWindow, doc = frame.contentDocument;
    doc.getElementById('page-action').click();
    win.scrollTo(0, 300); await wait(100);
    assert(win.scrollY === 300 && doc.getElementById('page-action').textContent === '网页点击已响应' && resized().length === 0,
      '网页实际滚动与点击已响应，固定区域不误报尺寸变化');
    await api.command('SET', { tool: 'text' });
    const root = doc.querySelector('yinglu-overlay').shadowRoot;
    root.querySelector('svg').dispatchEvent(new win.PointerEvent('pointerdown', { button: 0, clientX: 120, clientY: 100, bubbles: true }));
    const editor = root.querySelector('textarea'); editor.value = '固定范围内文字标注';
    await api.command('SET', { tool: 'pointer' });
    win.dispatchEvent(new win.Event('resize')); await wait(100);
    assert(root.querySelector('.annotation-text')?.textContent === '固定范围内文字标注' && resized().length === 0,
      '真实文字编辑、工具切换及同尺寸 resize 事件不误停');
    win.scrollTo(0, 0); await wait(100);
    assert(resized().length === 0, '滚回网页原位置无需重新框选');
    await api.command('BEGIN', { sessionId: 'first', crop: { viewportWidth: 800, viewportHeight: 600 }, deferViewport: true, diagnostics: false });
    frame.style.height = '559px'; await wait(150);
    assert(resized().length === 0, '重复 BEGIN 不恢复旧基线，1 CSS 像素误差不误停');
    frame.style.height = '520px'; await wait(150);
    assert(resized().length === 1 && resized()[0].sessionId === 'first' && resized()[0].height === 520, '正式录制后真实尺寸变化仍通知停止');
    frame.style.height = '500px'; await wait(150);
    assert(resized().length === 1, '同次录制只上报一次真实尺寸变化');
    await api.command('END', { sessionId: 'first' }); frame.style.height = '540px'; await wait(150);
    assert(resized().length === 1, '结束后释放本轮尺寸保护');
    await api.command('BEGIN', { sessionId: 'second', crop: { viewportWidth: 800, viewportHeight: 540 }, deferViewport: true, diagnostics: false });
    const pending = api.command('CAPTURE_VIEWPORT', { sessionId: 'second' });
    await api.command('END', { sessionId: 'second' });
    assert((await pending).ok === false, '取消准备会终结尚未完成的视口握手');
    assert((await api.command('ARM_VIEWPORT', { sessionId: 'first', crop: { viewportWidth: 800, viewportHeight: 560 } })).ok === false, '过期会话不能重新启用尺寸保护');
    result.textContent += '\n全部通过。';
  } catch (error) { result.textContent += `\nFAIL ${error.stack || error.message}`; }
  finally { await api?.command('END'); frame.style.height = '600px'; button.disabled = false; }
};
