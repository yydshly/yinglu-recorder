export function unsupportedPage(url = '') {
  if (!url) return null; // activeTab may not have exposed the URL yet.
  try {
    const page = new URL(url);
    if (page.protocol === 'chrome-extension:') return '这是插件自身的页面。请先切回鹧鸪项目，再点击浏览器右上角的映录图标。';
    if (!['http:', 'https:', 'file:'].includes(page.protocol)) return '这是浏览器内部页面，不能添加网页标注。请先打开鹧鸪项目，再点击浏览器右上角的映录图标。';
    if (page.hostname === 'chromewebstore.google.com' || (page.hostname === 'chrome.google.com' && page.pathname.startsWith('/webstore'))) {
      return 'Chrome 扩展商店不允许添加标注。请先切回鹧鸪项目，再点击浏览器右上角的映录图标。';
    }
  } catch { return '无法识别这个网页地址，请切回项目网页再试。'; }
  return null;
}

export function connectionError(cause, stage = 'connect', url = '') {
  if (cause?.connectionError) return cause;
  const detail = cause?.message || String(cause || '未知错误');
  let message, code;
  if (stage === 'capture' && /not been invoked|activeTab/i.test(detail)) {
    code = 'CAPTURE_ACTIVATION_REQUIRED';
    message = '网页已连接，但 Chrome 尚未授予这个标签页的录制权限。请在当前网页点击一次映录图标后再开始录制。网站自动连接权限不能代替此授权。';
  } else if (/No tab with id|tab was closed|Invalid tab ID/i.test(detail)) {
    message = '之前选中的网页已经关闭。切回要录制的网页，然后点击网页信息右侧的 ↻ 刷新按钮重新连接。';
  } else if (/Cannot access|permission|not allowed|Missing host/i.test(detail)) {
    code = url.startsWith('file:') ? 'FILE_ACCESS_REQUIRED' : 'HOST_ACCESS_REQUIRED';
    message = url.startsWith('file:')
      ? 'Chrome 尚未允许映录访问本地文件。请在扩展详情中打开「允许访问文件网址」，或使用项目的网站地址。'
      : 'Chrome 尚未授权这个网页。可在侧栏开启「自动连接网页」；若已开启，请检查扩展的网站访问权限，或点击映录图标临时授权。';
  } else if (stage === 'initialize') {
    message = '网页标注启动失败。可点击网页信息右侧的 ↻ 刷新按钮重试；若仍失败，请把下方错误详情发给我。';
  } else {
    message = '暂时没有连上网页。请点击网页信息右侧的 ↻ 刷新按钮重新连接；若仍失败，请把下方错误详情发给我。';
  }
  const error = new Error(message);
  error.detail = `[${stage}] ${detail}`;
  error.connectionError = true;
  if (code) error.code = code;
  return error;
}

export function validateHandshake(reply) {
  return reply?.ok === true && Number.isFinite(reply.width) && reply.width > 0
    && Number.isFinite(reply.height) && reply.height > 0;
}
