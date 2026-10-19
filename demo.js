const panel = document.getElementById('panel');
window.addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== panel.contentWindow || e.data?.type !== 'YINGLU_COMMAND') return;
  window.dispatchEvent(new CustomEvent('yinglu-demo-command', { detail: e.data.command }));
});
window.addEventListener('yinglu-demo-event', e => panel.contentWindow.postMessage({ type: 'YINGLU_EVENT', event: e.detail }, location.origin));
const scene = document.getElementById('scene');
document.getElementById('animate').onclick = e => { scene.classList.toggle('stopped'); e.target.textContent = scene.classList.contains('stopped') ? '继续动画' : '暂停动画'; };
document.getElementById('theme').onclick = () => { scene.style.filter = scene.style.filter ? '' : 'sepia(.25) hue-rotate(325deg) saturate(1.3)'; };
document.getElementById('reset').onclick = () => { scene.style.filter = ''; scene.classList.remove('stopped'); document.getElementById('animate').textContent = '暂停动画'; };
