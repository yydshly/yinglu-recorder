import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRecordingMime, isRecordingFormatSupported, mediaFormat, extensionForMime } from '../lib/media-format.js';
test('MP4必须实际支持H264/AAC，不用改后缀或其它容器冒充', () => {
  const webmOnly = { isTypeSupported: type => type.startsWith('video/webm') };
  assert.equal(isRecordingFormatSupported('mp4', webmOnly), false);
  assert.throws(() => chooseRecordingMime('mp4', webmOnly), /H.264.*AAC/);
  assert.match(chooseRecordingMime('webm', webmOnly), /webm/);
  assert.match(chooseRecordingMime('mp4', { isTypeSupported: type => type.includes('avc1,mp4a.40.2') }), /avc1,mp4a/);
});
test('容器和后缀根据实际MIME确定，缺少API不误判支持', () => {
  assert.equal(mediaFormat('video/mp4;codecs=avc1.42001E,mp4a.40.2'), 'mp4');
  assert.equal(extensionForMime('video/webm'), 'webm');
  assert.equal(extensionForMime('video/mp4'), 'mp4');
  assert.equal(isRecordingFormatSupported('mp4', {}), false);
  assert.equal(isRecordingFormatSupported('unknown', {}), false);
});
