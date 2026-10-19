import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore } from '../lib/idb-store.js';
const tick = () => new Promise(resolve=>setImmediate(resolve));
function harness(t) {
  const h={requests:[],writes:0}; const descriptor=Object.getOwnPropertyDescriptor(globalThis,'indexedDB');
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){const req={};h.requests.push(req);return req;}}});
  t.after(()=>descriptor?Object.defineProperty(globalThis,'indexedDB',descriptor):delete globalThis.indexedDB);
  h.db=()=>({closes:0,close(){this.closes++;},transaction(){
    if(this.closed)throw new DOMException('closed','InvalidStateError');
    const tx={abort(){this.onabort?.();}};
    tx.objectStore=()=>({get(){const req={};queueMicrotask(()=>{req.result='kept';tx.oncomplete?.();});return req;},put(){h.writes++;queueMicrotask(()=>h.failWrite?tx.onabort?.():tx.oncomplete?.());}});return tx;
  }});
  h.success=(i,db=h.db())=>{h.requests[i].result=db;h.requests[i].onsuccess();return db;};
  h.run=createLocalStore({name:'test-assets',stores:['files'],label:'素材',timeoutMs:20});
  h.read=options=>h.run(['files'],'readonly',tx=>{const req=tx.objectStore('files').get('id');return()=>req.result;},options);
  return h;
}
test('构造素材连接管理器不打开数据库，多个首次读取共用一个打开请求',async t=>{
  const h=harness(t);assert.equal(h.requests.length,0);const a=h.read(),b=h.read();assert.equal(h.requests.length,1);h.success(0);assert.deepEqual(await Promise.all([a,b]),['kept','kept']);
});
test('素材打开挂起后可重连，迟到成功关闭自身，旧关闭回调不清掉新连接',async t=>{
  const h=harness(t);await assert.rejects(h.read(),/超时/);const next=h.read(),db=h.success(1);await next;
  const old=h.success(0);assert.equal(old.closes,1);assert.equal(db.closes,0);
  db.onversionchange();const third=h.read();h.success(2);await third;db.onclose();await h.read();assert.equal(h.requests.length,3);
});
test('关闭连接在创建事务前重连一次，已失败写入不重放',async t=>{
  const h=harness(t);const a=h.read(),old=h.success(0);await a;old.closed=true;
  const b=h.read();await tick();h.success(1);assert.equal(await b,'kept');h.failWrite=true;
  await assert.rejects(h.run(['files'],'readwrite',tx=>tx.objectStore('files').put({id:'x'})),/中断/);assert.equal(h.writes,1);assert.equal(h.requests.length,2);
});
test('取消一个素材读取者不取消其他打开等待者',async t=>{
  const h=harness(t),controller=new AbortController();const a=h.read({signal:controller.signal}),b=h.read();controller.abort();await assert.rejects(a,{name:'AbortError'});h.success(0);assert.equal(await b,'kept');
});
