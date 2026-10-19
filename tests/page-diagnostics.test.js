import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDiagnostic, diagnosticSample } from '../lib/page-diagnostics.js';

test('页面诊断只保留有界指标，不能冒充实际视频帧率', () => {
  const entry = diagnosticSample({ phase: 'recording', sample: { scope: 'top-document', metric: 'raf-cadence', visibility: 'visible',
    enoughData: true, durationMs: 2000, raf: { intervalCount: 100, meanMs: 20, cadenceHz: 50, ignored: 'arbitrary' },
    longTasks: { supported: true, count: 2, totalMs: 120, maxMs: 65 }, webglContextLost: 1, arbitrary: 'private' } });
  assert.equal(entry.sample.raf.cadenceHz, 50);
  assert.equal(entry.sample.raf.ignored, undefined);
  assert.equal(entry.sample.arbitrary, undefined);
  assert.equal(entry.sample.longTasks.totalMs, 120);
  assert.equal(entry.sample.webglContextLost, 1);
});
test('无效诊断被忽略，非有限或负数没有伪造为0', () => {
  assert.equal(diagnosticSample({ phase: 'other', sample: {} }), null);
  assert.equal(diagnosticSample({ phase: 'recording', sample: { scope: 'iframe', metric: 'raf-cadence', visibility: 'visible' } }), null);
  const { sample } = diagnosticSample({ phase: 'baseline', sample: { scope: 'top-document', metric: 'raf-cadence', visibility: 'hidden',
    durationMs: NaN, visibleMs: -1, longTasks: { supported: false, count: null } } });
  assert.equal(sample.durationMs, null); assert.equal(sample.visibleMs, null);
  assert.equal(sample.raf, null); assert.equal(sample.longTasks.count, null);
});
test('长录制诊断限量保存并保留前后对比', () => {
  let profile = appendDiagnostic({ samples: [] }, { phase: 'baseline', sample: { before: true } });
  for (let i = 0; i < 100; i++) profile = appendDiagnostic(profile, { phase: 'recording', sample: { i } });
  profile = appendDiagnostic(profile, { phase: 'recovery', sample: { after: true } });
  assert.equal(profile.samples.length, 62);
  assert.equal(profile.samples[0].sample.before, true);
  assert.equal(profile.samples[1].sample.i, 40);
  assert.equal(profile.samples.at(-1).sample.after, true);
});
