const output = document.getElementById('result');
function assert(ok, label) { if (!ok) throw new Error(label); output.textContent += `\nPASS ${label}`; }
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
document.getElementById('run').onclick = async () => {
  const button = document.getElementById('run'); button.disabled = true;
  output.textContent = '运行中…';
  const native = window.indexedDB, descriptor = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  const name = 'yinglu-test-pagination-' + crypto.randomUUID(), connections = new Set();
  let frame;
  try {
    const opening = native.open(name, 1);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('recordings', { keyPath: 'id' });
      opening.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
    };
    const old = await request(opening); connections.add(old);
    const tx = old.transaction(['recordings','chunks'], 'readwrite'), committed = complete(tx);
    for (let i = 0; i < 245; i++) tx.objectStore('recordings').put({id:String(999-i),createdAt:100-Math.floor(i/60),title:`视频${i}`,bytes:5,mimeType:'video/webm',status:'complete',pageDiagnostics:{sample:'保留原数据'}});
    tx.objectStore('chunks').put({id:'999',index:0,blob:new Blob(['hello'])}); await committed;
    let closed = false; old.onversionchange = () => { closed = true; old.close(); };
    Object.defineProperty(window, 'indexedDB', {configurable:true,value:{open(_name,version){
      const req=native.open(name,version); req.addEventListener('success',()=>connections.add(req.result)); return req;
    }}});
    const api = await import('../lib/db.js?test=' + crypto.randomUUID());
    let page = await api.listRecordingPage(), rows = [...page.records];
    assert(closed, 'v1 连接收到版本变更后关闭，升级没有被旧页面挂起');
    const db = [...connections].at(-1);
    assert(db.version === 2 && db.objectStoreNames.length === 2, '升级保留原有两个数据仓库');
    assert(db.transaction('recordings').objectStore('recordings').indexNames.contains('createdAtId'), 'v2 建立时间与 ID 的复合索引');
    assert(page.records.length === 20 && page.hasMore, '首页仅返回20条与下一页游标');
    assert(!page.records[0].pageDiagnostics, '列表不持有详细诊断样本');
    assert((await api.getRecording('999')).pageDiagnostics.sample === '保留原数据', '升级与列表投影不删除原始元数据');
    assert(await (await api.recordingBlob('999')).text() === 'hello', '升级保留原始片段且仍可读取');
    const cursor = page.next;
    await api.saveRecording({id:'new',createdAt:101,title:'新录制'}); await api.deleteRecording('998');
    page = await api.listRecordingPage({before:cursor}); rows.push(...page.records);
    while (page.hasMore) { page = await api.listRecordingPage({before:page.next}); rows.push(...page.records); }
    assert(rows.length === 245 && new Set(rows.map(r=>r.id)).size === 245, '同时间记录与并发新增、删除不会使后续页重复或跳过未读记录');
    assert(!rows.some(r=>r.id==='new') && page.next===null, '后续页沿固定游标读取，最后一页正确结束');
    assert((await api.listRecordingPage({limit:3})).records[0].id==='new', '刷新最近三条可以读到新增记录');
    const controller = new AbortController(); controller.abort();
    let canceled = false; try { await api.listRecordingPage({signal:controller.signal}); } catch(e) {canceled=e.name==='AbortError';}
    assert(canceled, '已取消的列表读取不启动新工作');
    db.close();
    assert((await api.getRecording('999')).id==='999', '已关闭连接在事务创建阶段安全重连');
    frame = document.createElement('iframe'); frame.title='真实录制库分页预览'; frame.style.cssText='width:100%;height:640px;border:1px solid #ccc';
    const html = await (await fetch('../library.html')).text();
    const base = new URL('../', location.href).href;
    const init = `<base href="${base}"><script>const testNative=indexedDB,testConnections=new Set();Object.defineProperty(window,'indexedDB',{value:{open(_name,version){const req=testNative.open(${JSON.stringify(name)},version);req.addEventListener('success',()=>testConnections.add(req.result));return req;}}});window.closeTestDatabase=()=>{for(const db of testConnections)db.close();};<\/script>`;
    const loaded = new Promise(resolve=>frame.onload=resolve);
    frame.srcdoc=html.replace('<head>','<head>'+init); document.body.append(frame); await loaded;
    const doc=frame.contentDocument;
    const waitFor = check => new Promise((resolve,reject)=>{
      if(check()) {resolve();return;}
      const observer=new MutationObserver(()=>{if(check()){clearTimeout(timer);observer.disconnect();resolve();}});
      const timer=setTimeout(()=>{observer.disconnect();reject(new Error('录制库界面等待超时：'+doc.getElementById('error')?.textContent));},10000);
      observer.observe(doc,{childList:true,attributes:true,subtree:true,characterData:true});
    });
    await waitFor(()=>doc.getElementById('list-status')?.textContent.includes('20') && !doc.getElementById('load-more').disabled);
    const card=doc.getElementById('list').firstElementChild;
    assert(doc.querySelectorAll('.library-card').length===20 && !doc.getElementById('load-more').hidden,'真实录制库首次显示20张卡片及载入更多按钮');
    doc.getElementById('load-more').click();
    await waitFor(()=>doc.getElementById('list-status').textContent.includes('40') && !doc.getElementById('load-more').disabled);
    assert(doc.querySelectorAll('.library-card').length===40 && card===doc.getElementById('list').firstElementChild,'真实录制库追加下一页时保留原卡片');
    assert(!doc.getElementById('error').textContent && !doc.querySelector('video[src]'),'列表不创建视频预览或读取录制片段');
    output.textContent += '\n全部通过。';
  } catch(error) { output.textContent += `\nFAIL ${error.stack}`; }
  finally {
    frame?.contentWindow?.closeTestDatabase?.(); frame?.remove();
    if(descriptor) Object.defineProperty(window,'indexedDB',descriptor); else delete window.indexedDB;
    for(const db of connections) db.close();
    await request(native.deleteDatabase(name)); button.disabled=false;
  }
};
