const phases = new Set(['baseline', 'recording', 'recovery']);
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
const numbers = (source, keys) => Object.fromEntries(keys.map(key => [key, number(source?.[key])]));

// Accept only the small metric payload produced by our top-document probe.
// These are page scheduling observations, not measured encoded video FPS.
export function diagnosticSample(message) {
  const value = message?.sample;
  if (!phases.has(message?.phase) || value?.scope !== 'top-document' || value.metric !== 'raf-cadence' ||
      !['visible', 'hidden'].includes(value.visibility)) return null;
  return { phase: message.phase, at: Date.now(), sample: {
    scope: 'top-document', metric: 'raf-cadence', reason: String(value.reason || '').slice(0, 80),
    visibility: value.visibility, durationMs: number(value.durationMs), visibleMs: number(value.visibleMs),
    enoughData: value.enoughData === true,
    raf: value.raf ? numbers(value.raf, ['intervalCount', 'meanMs', 'p95Ms', 'maxMs', 'over50ms', 'cadenceHz']) : null,
    longTasks: { supported: value.longTasks?.supported === true, ...numbers(value.longTasks, ['count', 'totalMs', 'maxMs']) },
    webglContextLost: number(value.webglContextLost)
  } };
}

export function appendDiagnostic(profile, entry) {
  const samples = [...(profile.samples || []), entry];
  // Preserve the baseline and recent recovery, bound session-storage growth on
  // long recordings. No new IDB transaction is needed while capture is active.
  const baseline = samples.filter(item => item.phase === 'baseline').slice(-2);
  const recording = samples.filter(item => item.phase === 'recording').slice(-60);
  const recovery = samples.filter(item => item.phase === 'recovery').slice(-4);
  return { ...profile, samples: [...baseline, ...recording, ...recovery] };
}
