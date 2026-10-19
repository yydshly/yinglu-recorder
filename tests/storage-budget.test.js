import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStorageBudget, estimateMp4Bytes } from '../lib/storage-budget.js';
test('空间明显不足时在文件创建前阻止暂存，估算含额外开销',async()=>{
  await assert.rejects(ensureStorageBudget({estimate:async()=>({usage:90e6,quota:100e6})},20e6),/空间不足/);
  await ensureStorageBudget({estimate:async()=>({usage:1e6,quota:100e6})},20e6);
});
test('缺失、被拒绝或超时的空间估算不禁用可用的文件路径，取消仍及时生效',async()=>{
  for(const storage of [{},{estimate:async()=>{throw new DOMException('denied','SecurityError');}},{estimate:async()=>({})}])await ensureStorageBudget(storage,100);
  await ensureStorageBudget({estimate:()=>new Promise(()=>{})},100,{timeoutMs:5});
  const controller=new AbortController();const pending=ensureStorageBudget({estimate:()=>new Promise(()=>{})},100,{signal:controller.signal});controller.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
test('MP4空间按目标编码与时长估算，不能直接当作源文件大小',()=>{
  const small={width:1280,height:720,fps:30,duration:60000,bytes:1000};
  assert.ok(estimateMp4Bytes(small)>20e6);assert.ok(estimateMp4Bytes({...small,duration:120000})>estimateMp4Bytes(small));
});
