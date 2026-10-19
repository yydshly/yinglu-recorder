const candidates = {
  webm: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'],
  mp4: ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.42E02A,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42001E,mp4a.40.2']
};

export function chooseRecordingMime(format = 'webm', Recorder = globalThis.MediaRecorder) {
  if (!candidates[format]) throw new Error('不支持的录制格式');
  const mime = candidates[format].find(type => {
    try { return Recorder?.isTypeSupported(type); } catch { return false; }
  });
  if (!mime) throw new Error(format === 'mp4'
    ? '当前浏览器不支持 H.264 + AAC 的 MP4 编码。请升级 Chrome / Edge，或使用 WebM；原视频仍可保留。'
    : '当前浏览器不支持 WebM 录制，请使用新版 Chrome 或 Edge');
  return mime;
}
export function isRecordingFormatSupported(format, Recorder = globalThis.MediaRecorder) {
  try { return !!chooseRecordingMime(format, Recorder); } catch { return false; }
}
export function mediaFormat(mime = '') { return String(mime).toLowerCase().startsWith('video/mp4') ? 'mp4' : 'webm'; }
export function extensionForMime(mime) { return mediaFormat(mime); }
