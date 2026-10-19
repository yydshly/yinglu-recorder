import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (await readFile(new URL('../lib/music-panel.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise(resolve=>setImmediate(resolve));
const deferred = () => { let resolve; return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}; };
async function harness(t) {
  const h={calls:[],channels:[],errors:[],state:{status:'idle'},prefs:{id:'song',enabled:true,volume:.2,loop:true},revoked:[],urls:[]}, elements=new Map(), events={};
  class Element {
    constructor(){this.children=[];this.handlers={};this.paused=true;this.src='';}
    append(...nodes){this.children.push(...nodes);} replaceChildren(){this.children=[];}
    addEventListener(n,fn){this.handlers[n]=fn;} removeAttribute(n){this[n]='';} getAttribute(n){return this[n];}
    load(){h.calls.push('load');} pause(){this.paused=true;} async play(){h.calls.push('play');this.paused=false;}
  }
  h.get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const deps={
    listMusic:async()=>{h.calls.push('list');if(h.listGate)await h.listGate;return [{id:'song',name:'音乐',duration:5,bytes:10}];},
    getMusicPreferences:async()=>{h.calls.push('prefs');return {...h.prefs};},
    getMusicFile:async()=>{h.calls.push('file');if(h.fileGate)await h.fileGate;return new Blob(['music']);},
    saveMusicPreferences:async p=>{h.prefs={...p};}, musicConfig:p=>({id:p.id,volume:p.volume,loop:p.loop}),
    prepareMusicFile:async()=>{},saveMusic:async()=>{},deleteMusic:async()=>{}
  };
  const values={document:{hidden:false,getElementById:h.get,createElement:tag=>{const e=new Element();if(tag==='audio')h.player=e;return e;},addEventListener:(n,fn)=>events[n]=fn,removeEventListener(){}},window:{addEventListener(){}},
    BroadcastChannel:class {constructor(){h.channels.push(this);}postMessage(){}close(){}},musicPanelDeps:deps};
  for(const [key,value] of Object.entries(values)){const d=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});t.after(()=>{if(key==='document')h.api?.dispose();d?Object.defineProperty(globalThis,key,d):delete globalThis[key];});}
  t.mock.method(URL,'createObjectURL',blob=>{h.urls.push(blob);return 'blob:music-'+h.urls.length;}); t.mock.method(URL,'revokeObjectURL',url=>h.revoked.push(url));
  const module=await import('data:text/javascript;base64,'+Buffer.from('const {listMusic,getMusicFile,saveMusic,deleteMusic,getMusicPreferences,saveMusicPreferences,musicConfig,prepareMusicFile}=globalThis.musicPanelDeps;\n'+source+'\n//'+Math.random()).toString('base64'));
  h.api=module.createMusicPanel({getRecording:()=>h.state,canImport:()=>true,send:async()=>{},onBusy:()=>{},onError:e=>h.errors.push(e)});
  await tick();
  h.open=async(value=true)=>{h.get('music-card').open=value;h.get('music-card').handlers.toggle();await tick();};
  h.visibility=async hidden=>{document.hidden=hidden;events.visibilitychange();await tick();};return h;
}
test('侧栏音乐收起时不读数据库，开始录制仅读偏好而不提前载入音频',async t=>{
  const h=await harness(t);assert.deepEqual(h.calls,[]);
  assert.deepEqual(await h.api.beforeRecording(),{id:'song',volume:.2,loop:true});assert.deepEqual(h.calls,['prefs']);assert.equal(h.urls.length,0);
});
test('展开和选择音乐只读元数据，点击试听才读音频；收起释放URL与播放器',async t=>{
  const h=await harness(t);await h.open();assert.deepEqual(h.calls,['list','prefs']);assert.equal(h.get('music-play').disabled,false);
  h.get('music-select').value='song';await h.get('music-select').onchange();assert.equal(h.calls.includes('file'),false);
  await h.get('music-play').onclick();assert.equal(h.calls.filter(c=>c==='file').length,1);assert.equal(h.player.paused,false);
  await h.open(false);assert.equal(h.player.src,'');assert.equal(h.player.paused,true);assert.equal(h.revoked.length,1);
  await h.open();assert.equal(h.calls.filter(c=>c==='file').length,1);
});
test('试听读取期间收起后，迟到文件不创建URL、不开始播放',async t=>{
  const h=await harness(t);await h.open();const gate=deferred();h.fileGate=gate.promise;
  const play=h.get('music-play').onclick();await tick();await h.open(false);gate.resolve();await play;
  assert.equal(h.urls.length,0);assert.equal(h.calls.includes('play'),false);
});
test('隐藏侧栏释放试听，恢复可见不会自动重新读取音频',async t=>{
  const h=await harness(t);await h.open();await h.get('music-play').onclick();await h.visibility(true);assert.equal(h.player.src,'');
  await h.visibility(false);assert.equal(h.calls.filter(c=>c==='file').length,1);assert.equal(h.player.paused,true);
});
test('收起时广播仅标记更新，录制前读取最新音乐偏好',async t=>{
  const h=await harness(t);await h.open();await h.open(false);const reads=h.calls.length;
  h.prefs.enabled=false;h.channels[0].onmessage({data:'changed'});await tick();assert.equal(h.calls.length,reads);
  assert.equal(await h.api.beforeRecording(),null);assert.equal(h.calls.includes('file'),false);
});
test('展开读取尚未完成时收起再展开，旧结果隔离并补查一次',async t=>{
  const h=await harness(t),gate=deferred();h.listGate=gate.promise;await h.open();await h.open(false);await h.open();
  h.listGate=null;gate.resolve();await tick();await tick();assert.equal(h.get('music-play').disabled,false);assert.equal(h.calls.filter(c=>c==='list').length,2);
});
