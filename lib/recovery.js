// Call only after capture has been confirmed closed. Existing chunks remain
// untouched; duration describes the saved chunks, while attemptedDuration may
// include time whose media never reached storage.
export async function recoverStoppedRecording(state, { getRecording, patchRecording }, reason) {
  const record = state.id ? await getRecording(state.id) : null;
  if (!record) return { status: 'error', id: state.id, bytes: 0,
    duration: 0, error: `${reason}。尚未找到可恢复的视频片段。` };
  if (!record.bytes) {
    // An empty placeholder must not remain active or appear complete in the
    // library. A late transaction may commit media between the read and patch.
    const patched = await patchRecording(record.id, { status: 'error', interruption: reason });
    if (!patched?.bytes) return { status: 'error', id: record.id, bytes: 0,
      duration: 0, error: `${reason}。尚未找到可恢复的视频片段。` };
    Object.assign(record, patched);
  }
  if (record.status === 'complete') return { status: 'complete', id: record.id, bytes: record.bytes, duration: record.duration, error: null };
  const patched = await patchRecording(record.id, { status: 'interrupted', interruption: reason });
  const saved = patched?.id === record.id ? patched : record;
  return { status: 'interrupted', id: record.id, bytes: saved.bytes, duration: saved.duration,
    error: `${reason}。已保留写入的片段，最后一段可能不完整。` };
}
