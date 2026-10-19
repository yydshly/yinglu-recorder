import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRect, cropPixels, outputSize, elapsed, clockText } from '../lib/geometry.js';
test('框选支持从右下往左上拖动，且不越出画面', () => {
  assert.deepEqual(normalizeRect({ x: 90, y: 80 }, { x: -30, y: 20 }, 100, 100), { x: 0, y: .2, width: .9, height: .6 });
});
test('高 DPI 录制的裁切像素随视频分辨率缩放', () => {
  assert.deepEqual(cropPixels({ x: .25, y: .25, width: .5, height: .5 }, 2560, 1440), { x: 640, y: 360, width: 1280, height: 720 });
});
test('边缘裁切不越界，输出保持偶数尺寸并且不放大', () => {
  assert.deepEqual(cropPixels({ x: .9, y: .9, width: .5, height: .5 }, 100, 80), { x: 90, y: 72, width: 10, height: 8 });
  assert.deepEqual(outputSize(3840, 2160), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(2160, 3840), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize(639, 359), { width: 638, height: 358 });
  assert.deepEqual(outputSize(3840, 2160, 'performance'), { width: 1280, height: 720 });
});
test('计时排除暂停时间并支持超过一小时', () => {
  assert.equal(elapsed({ startedAt: 1000, pausedAt: 8000, pausedMs: 2000 }, 10000), 5000);
  assert.equal(elapsed({ startedAt: 1000, pausedAt: 0, pausedMs: 4000 }, 10000), 5000);
  assert.equal(clockText(3661000), '01:01:01');
});
