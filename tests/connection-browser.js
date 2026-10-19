const frame = document.getElementById('panel'), output = document.getElementById('result'), run = document.getElementById('run');
const page = await (await fetch('../panel.html')).text();
frame.srcdoc = page.replace('<head>', `<head><base href="${new URL('../', location.href)}">`)
  .replace(/<script type="module" src="panel.js"><\/script>/, '<script type="module" src="tests/connection-browser-frame.js"></script>');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const start = Date.now(); while (!check()) { if (Date.now() - start > 18000) throw new Error('等待侧栏状态超时'); await wait(30); } }
await until(() => frame.contentWindow.connectionFixture?.ready);
output.textContent = '已就绪，点击运行。';
document.getElementById('switch').onclick = () => {
  const api = frame.contentWindow.connectionFixture; api.activate(api.active() === 7 ? 8 : 7);
};
run.onclick = async () => {
  run.disabled = true; output.textContent = '运行中…';
  const api = frame.contentWindow.connectionFixture, doc = frame.contentDocument;
  const assert = (value, label) => { if (!value) throw new Error(label); output.textContent += `\nPASS ${label}`; };
  try {
    await until(() => !doc.getElementById('auto-connect').hidden);
    assert(api.intervals.size === 0 && !doc.getElementById('diagnostics').checked, '空闲无持续计时轮询，诊断默认关闭');
    assert(api.requests === 0, '初始化不弹网站访问授权');
    assert(doc.getElementById('page-title').textContent === '当前网页待授权', '缺少网页标题与地址时提示待授权，不永久等待连接');
    assert(doc.getElementById('error').hidden && doc.getElementById('error-details').hidden && !doc.getElementById('auto-connect-guide').hidden
      && /等待网页授权/.test(doc.getElementById('status-label').textContent), '首次使用显示等待授权引导，旧权限错误不显示成连接失败');
    const retry = doc.getElementById('reconnect'), box = retry.getBoundingClientRect();
    assert(retry.closest('.source') && retry.getAttribute('aria-label') === '刷新获取当前网页' && box.width >= 30 && box.height >= 30, '网页信息旁有常驻可点击的刷新获取按钮');
    retry.click(); await until(() => !retry.disabled && /等待授权/.test(doc.getElementById('connection-label').textContent));
    assert(doc.getElementById('error').hidden && !doc.getElementById('auto-connect-guide').hidden, '未授权时点击刷新仍回到授权引导，不出现红色故障');
    doc.getElementById('auto-connect').click();
    await until(() => api.requests === 1 && !doc.getElementById('auto-connect').disabled && /暂未开启/.test(doc.getElementById('auto-connect-hint').textContent));
    assert(doc.getElementById('error').hidden && !doc.getElementById('auto-connect-guide').hidden, '取消授权后温和提示，可再次开启，不自动重弹授权');
    api.allowPermission = true; doc.getElementById('auto-connect').click();
    await until(() => doc.getElementById('connected').classList.contains('live'));
    assert(api.requests === 2 && doc.getElementById('auto-connect-guide').hidden && !doc.getElementById('start').disabled, '再次允许后立即连接当前网页，清除旧失败并恢复开始录制');
    const firstInjections = api.injections.length;
    api.dropTabNotifications = true; api.activate(8);
    await until(() => doc.getElementById('page-title').textContent === '性能参数示例 B' && doc.getElementById('connected').classList.contains('live'));
    assert(api.injections.at(-1) === 8 && api.injections.length === firstInjections + 1 && api.droppedNotifications > 0, '后台广播丢失时仍直接识别并连接新页，无需点击插件或刷新');
    api.activate(7);
    await until(() => doc.getElementById('page-title').textContent === '骑行演示 A' && doc.getElementById('connected').classList.contains('live'));
    assert(api.injections.length === firstInjections + 1, '切回已有连接复用标注脚本');
    api.activate(8, false); retry.click();
    await until(() => doc.getElementById('page-title').textContent === '性能参数示例 B' && doc.getElementById('connected').classList.contains('live') && !retry.disabled);
    assert(api.injections.length === firstInjections + 1, '漏掉自动切页事件时，点击刷新仍能获取当前网页并恢复连接');
    api.stall = true; api.activate(9);
    await until(() => !doc.getElementById('error').hidden && /加载超时/.test(doc.getElementById('error-detail').textContent));
    assert(!/正在连接/.test(doc.getElementById('connection-label').textContent), '注入超时显示明确错误，不永久连接中');
    const count = api.injections.length; api.refresh(); await wait(150);
    assert(api.injections.length === count, '失败后的刷新不反复注入');
    api.stall = false; doc.getElementById('reconnect').click();
    await until(() => doc.getElementById('connected').classList.contains('live') && !doc.getElementById('reconnect').disabled);
    assert(doc.getElementById('error').hidden, '重试连接可恢复，不必刷新网页或插件');
    api.activate(10);
    await until(() => /地址就绪后自动连接/.test(doc.getElementById('connection-label').textContent));
    assert(doc.getElementById('error').hidden, '切换时地址尚未就绪显示加载中，不误报需要重新授权');
    await api.update(10, { url: 'https://loading.example/', title: '地址就绪但仍在加载', status: 'loading' });
    await until(() => doc.getElementById('page-title').textContent === '地址就绪但仍在加载' && doc.getElementById('connected').classList.contains('live'));
    assert(api.injections.includes(10), '网址就绪立即自动连接，未等待 complete，也未点击刷新');
    api.failOnce.add(11); api.activate(11);
    await until(() => !doc.getElementById('error').hidden);
    await api.update(11, { status: 'complete' });
    await until(() => doc.getElementById('page-title').textContent === '加载恢复示例' && doc.getElementById('connected').classList.contains('live'));
    assert(doc.getElementById('error').hidden, '加载期短暂连接失败后，网页加载完成自动恢复');
    api.failOnce.add(12); api.activate(12); await until(() => !doc.getElementById('error').hidden);
    api.activate(7); await until(() => doc.getElementById('page-title').textContent === '骑行演示 A' && doc.getElementById('connected').classList.contains('live'));
    api.activate(12); await until(() => doc.getElementById('page-title').textContent === '切回自动恢复示例' && doc.getElementById('connected').classList.contains('live'));
    assert(doc.getElementById('error').hidden, '切走再切回自动重试，不被先前失败永久阻塞');
    assert(api.intervals.size === 0 && api.mediaStarts === 0, '连接和切换不会启动录制、持续计时或离屏采集');
    output.textContent += '\n\n19 项通过。模拟接口验证完成；Chrome 实录及系统负载仍需实机测量。';
  } catch (error) { output.textContent += `\nFAIL ${error.message}`; }
  finally { run.disabled = false; }
};
