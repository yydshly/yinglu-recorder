import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverStoppedRecording } from '../lib/recovery.js';

test('强制停止只修复元数据，保留已写入片段及最后确认时长', async () => {
  const patches = [];
  const state = await recoverStoppedRecording({ id: 'one' }, {
    getRecording: async () => ({ id: 'one', bytes: 1234, duration: 4000, status: 'recording' }),
    patchRecording: async (...args) => patches.push(args)
  }, '编码器未响应');
  assert.equal(state.status, 'interrupted'); assert.equal(state.duration, 4000);
  assert.deepEqual(patches[0], ['one', { status: 'interrupted', interruption: '编码器未响应' }]);
});

test('已保存完成的录制不因迟到强制停止降级或重复改写', async () => {
  const result = await recoverStoppedRecording({ id: 'one' }, {
    getRecording: async () => ({ id: 'one', bytes: 1234, duration: 5000, status: 'complete' }),
    patchRecording: () => { throw new Error('不应降级完成记录'); }
  }, '控制未响应');
  assert.equal(result.status, 'complete'); assert.equal(result.error, null);
});

test('尚无片段时不伪装恢复成功', async () => {
  const result = await recoverStoppedRecording({}, { getRecording: () => { throw new Error('无id不读库'); } }, '准备已中断');
  assert.equal(result.status, 'error'); assert.match(result.error, /尚未找到/);
});

test('存在空记录时持久化失败终态，不让占位记录继续显示录制中', async () => {
  let record = { id: 'empty', status: 'recording', bytes: 0, duration: 0 };
  const result = await recoverStoppedRecording({ id: record.id }, {
    getRecording: async () => ({ ...record }),
    patchRecording: async (id, patch) => (record = { ...record, ...patch })
  }, '录制已停止');
  assert.equal(result.status, 'error'); assert.equal(record.status, 'error');
  assert.equal(record.bytes, 0); assert.match(result.error, /尚未找到/);
});

test('恢复补丁返回实际持久化字节与覆盖时长，不返回较早读取的值', async () => {
  const result = await recoverStoppedRecording({ id: 'late' }, {
    getRecording: async () => ({ id: 'late', status: 'recording', bytes: 100, duration: 1000, attemptedDuration: 10000 }),
    patchRecording: async (id, patch) => ({ id, ...patch, bytes: 200, duration: 2000, attemptedDuration: 10000 })
  }, '写入中断');
  assert.equal(result.status, 'interrupted'); assert.equal(result.bytes, 200); assert.equal(result.duration, 2000);
});

test('空记录恢复期间迟到片段已提交时恢复为部分保存', async () => {
  let record = { id: 'late', status: 'recording', bytes: 0, duration: 0 };
  const result = await recoverStoppedRecording({ id: 'late' }, {
    getRecording: async () => ({ ...record }),
    patchRecording: async (id, patch) => (record = { ...record, ...patch, bytes: 100, duration: 1000 })
  }, '写入中断');
  assert.equal(result.status, 'interrupted'); assert.equal(record.status, 'interrupted');
  assert.equal(result.bytes, 100); assert.equal(result.duration, 1000);
});
