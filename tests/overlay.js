const command = (type, options) => window.dispatchEvent(new CustomEvent('yinglu-demo-command', { detail: { type, options } }));
const output = document.getElementById('result');
function assert(ok, message) { if (!ok) throw new Error(message); output.textContent += `\nPASS ${message}`; }
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  output.textContent = '运行中…';
  try {
    command('CLEAR'); command('SET', { tool: 'text' });
    const root = document.querySelector('yinglu-overlay').shadowRoot;
    const svg = root.querySelector('svg');
    svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: 300, clientY: 300, button: 0, bubbles: true }));
    const editor = root.querySelector('textarea');
    assert(!!editor, '文字工具在网页创建输入框');
    editor.value = '第一行\n第二行'; editor.dispatchEvent(new Event('blur'));
    assert(root.querySelector('.annotation-text')?.textContent === '第一行\n第二行', '完成后保留多行标注');
    const originalText = root.querySelector('.annotation-text'), originalGroup = originalText.closest('[data-id]');
    for (const tool of ['select', 'pointer', 'text', 'arrow', 'select']) command('SET', { tool });
    assert(root.querySelector('.annotation-text') === originalText && root.querySelector('[data-id]') === originalGroup &&
      originalGroup.lastElementChild.getAttribute('pointer-events') === 'all', '实际浏览器反复切换工具保留文字及图形节点，只改变命中区域');
    command('END');
    assert(svg.children.length === 0 && svg.style.pointerEvents === 'none', '结束后隐藏标注并恢复鼠标穿透');
    command('RESTORE');
    assert(root.querySelector('.annotation-text')?.textContent === '第一行\n第二行', '上次标注可恢复');
    command('END'); command('BEGIN', { clicks: true });
    assert(svg.children.length === 0, '新录制默认不带入隐藏的上次标注');
    command('CROP');
    assert(!root.querySelector('.hint').hidden && svg.style.pointerEvents === 'auto', '框选显示遮罩和取消入口');
    root.querySelector('.crop-cancel').click();
    assert(root.querySelector('.hint').hidden && svg.style.pointerEvents === 'none', '鼠标取消框选恢复网页操作');
    command('SET', { tool: 'rect' }); command('CROP', { selectionId: 'escape-test' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(root.querySelector('.hint').hidden && svg.style.pointerEvents === 'none', '已有绘图工具时 Escape 取消也恢复网页操作');
    command('SET', { tool: 'text' });
    svg.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 180, button: 0, bubbles: true }));
    let input = root.querySelector('textarea');
    const longText = '这是用于验证自动换行的长文字，完成输入后应保持框宽，不再突然展开成一条超长的单行文字。';
    input.value = longText; input.style.width = '180px'; input.dispatchEvent(new Event('input'));
    const editorWidth = input.getBoundingClientRect().width, editorFont = getComputedStyle(input).font;
    input.dispatchEvent(new Event('blur'));
    let text = root.querySelector('.annotation-text'), box = root.querySelector('foreignObject');
    assert(text.textContent === longText && Math.abs(text.getBoundingClientRect().width - editorWidth) < 1, '长文字保留原文与实际编辑框宽度');
    assert(text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1, '自动换行文字没有横向溢出或纵向截断');
    assert(getComputedStyle(text).font === editorFont, '文字编辑与显示使用相同字体和行距');
    const range = document.createRange(); range.selectNodeContents(text);
    assert(range.getClientRects().length > 1, '完成输入后仍按框宽折成多行');
    box.parentElement.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 110, clientY: 190 }));
    input = root.querySelector('textarea');
    assert(input?.value === longText && Math.abs(input.getBoundingClientRect().width - editorWidth) < 1, '重新编辑保留文字与框宽');
    input.style.width = '300px'; input.dispatchEvent(new Event('blur'));
    text = root.querySelector('.annotation-text');
    assert(Math.abs(text.getBoundingClientRect().width - 300) < 1, '只调整输入框宽度也会保存');
    command('UNDO');
    assert(Math.abs(root.querySelector('.annotation-text').getBoundingClientRect().width - editorWidth) < 1, '撤销可恢复调整前的文字框宽度');
    command('CLEAR'); command('SET', {tool:'pen'});
    // Geometry uses the real SVGPointList. Pointer capture alone is simulated:
    // synthetic PointerEvents do not create a native active pointer.
    const capture=svg.setPointerCapture, hasCapture=svg.hasPointerCapture;
    svg.setPointerCapture=()=>{}; svg.hasPointerCapture=()=>false;
    const pointer=(type,x,y,target=svg)=>target.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true}));
    const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    try {
      pointer('pointerdown',100,100);
      const group=svg.firstElementChild, path=group.querySelector('polyline'), hit=group.lastElementChild;
      for(let i=1;i<=3000;i++) { pointer('pointermove',100+i%500,100+i*7%350); if(i%30===0) await frame(); }
      pointer('pointerup',600,450);
      assert(svg.firstElementChild===group && group.querySelector('polyline')===path && group.lastElementChild===hit,'3000点笔迹复用同一路径与命中节点');
      assert(path.points.numberOfItems===3002,'真实 SVGPointList 追加采样且包含松开终点');
      const first=path.getAttribute('points'); command('SET',{tool:'select'});
      pointer('pointerdown',100,100,hit); pointer('pointermove',160,170); await frame();
      assert(path.getAttribute('points')===first && path.hasAttribute('transform'),'拖动过程中只更新矩阵，不重写3000点');
      pointer('pointerup',180,190);
      const moved=path.getAttribute('points');
      assert(!path.hasAttribute('transform') && path.points.getItem(0).x===180 && path.points.getItem(0).y===190,'松开后一次提交最终坐标并清除临时矩阵');
      const b=path.getBBox(), handle=svg.querySelector('[data-handle]');
      pointer('pointerdown',200,200,handle); pointer('pointermove',300,235); await frame();
      assert(path.getAttribute('points')===moved && getComputedStyle(path).vectorEffect==='non-scaling-stroke','缩放过程保留原始点和固定笔迹线宽');
      pointer('pointerup',300,235); const resized=path.getAttribute('points');
      const after=path.getBBox();
      assert(Math.abs(after.width-b.width-100)<.1 && Math.abs(after.height-b.height-35)<.1,'非等比缩放后的真实几何与选择框一致');
      command('UNDO'); assert(path.getAttribute('points')===moved,'撤销恢复移动后的长笔迹');
      command('UNDO'); assert(path.getAttribute('points')===first,'再次撤销恢复绘制时的长笔迹');
      command('REDO'); command('REDO'); assert(path.getAttribute('points')===resized,'重做恢复长笔迹缩放结果');
      command('END'); command('RESTORE');
      assert(svg.querySelector('polyline').getAttribute('points')===resized,'录制结束恢复保留最终长笔迹');
    } finally { svg.setPointerCapture=capture; svg.hasPointerCapture=hasCapture; }
    command('END'); output.textContent += '\n全部通过。';
  } catch (error) { command('END'); output.textContent += `\nFAIL ${error.stack}`; }
  finally {document.getElementById('run').disabled=false;}
};
