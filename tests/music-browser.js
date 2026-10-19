import { listMusic, getMusicFile, saveMusic, deleteMusic, getMusicPreferences, saveMusicPreferences } from '../lib/music-store.js';
import { getRecording, recordingBlob, deleteRecording } from '../lib/db.js';
import { prepareMusicFile } from '../lib/music-player.js';
import { isRecordingFormatSupported } from '../lib/media-format.js';
const frame = document.getElementById('panel'), result = document.getElementById('result'), run = document.getElementById('run');
const ownedMusic = new Set(), ownedVideos = new Set(), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let oldPreferences, playbackURL;
async function until(check) { const start = Date.now(); while (!check()) { if (Date.now() - start > 20000) throw new Error('等待音乐或录制状态超时'); await wait(30); } }
const html = await (await fetch('../panel.html')).text();
frame.srcdoc = html.replace('<head>', `<head><base href="${new URL('../', location.href)}">`).replace(/<script type="module" src="panel.js"><\/script>/, '<script type="module" src="tests/music-browser-frame.js"></script>');
await until(() => frame.contentWindow.musicFixture?.ready);
result.textContent = '已就绪。检查会短暂播放柔和的合成测试音。';
function tone() {
  const rate = 44100, samples = rate * 3, bytes = new ArrayBuffer(44 + samples * 2), view = new DataView(bytes);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 880 * i / rate) * .3 * 32767), true);
  return new File([bytes], `合成测试音-${crypto.randomUUID().slice(0, 6)}.wav`, { type: 'audio/wav' });
}
async function audioRMS(id) {
  const oldVideo = document.getElementById('playback'), video = document.createElement('video'), context = new AudioContext(); let node, analyser, silence;
  video.id = 'playback'; video.controls = true; oldVideo.replaceWith(video);
  try {
    if (playbackURL) URL.revokeObjectURL(playbackURL); playbackURL = URL.createObjectURL(await recordingBlob(id));
    video.hidden = false; video.loop = true;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('成片无法解码')); video.src = playbackURL; });
    node = context.createMediaElementSource(video); analyser = context.createAnalyser(); analyser.fftSize = 2048;
    silence = context.createGain(); silence.gain.value = 0; node.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
    await context.resume(); await video.play(); await wait(180);
    const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  } finally { video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true; node?.disconnect(); analyser?.disconnect(); silence?.disconnect(); await context.close(); }
}
document.getElementById('cleanup').onclick = async () => {
  for (const id of ownedMusic) await deleteMusic(id); for (const id of ownedVideos) await deleteRecording(id);
  ownedMusic.clear(); ownedVideos.clear(); if (oldPreferences) await saveMusicPreferences(oldPreferences);
  if (playbackURL) { URL.revokeObjectURL(playbackURL); playbackURL = null; }
  const channel = new BroadcastChannel('yinglu-music'); channel.postMessage('changed'); channel.close();
  result.textContent += '\n已清理本次合成音乐和视频，并恢复原音乐设置。';
};
run.onclick = async () => {
  run.disabled = true; result.textContent = '运行中…'; let api, fills = [], passed = 0;
  const assert = (ok, label) => { if (!ok) throw new Error(label); passed++; result.textContent += `\nPASS ${label}`; };
  try {
    if (ownedMusic.size || ownedVideos.size) throw new Error('请先清理上次检查数据。');
    await until(() => frame.contentWindow.musicFixture?.ready);
    api = frame.contentWindow.musicFixture; const doc = frame.contentDocument;
    assert(!api.databaseOpens.includes('yinglu-music') && !api.databaseOpens.includes('yinglu-image-materials') && api.musicFileReads===0, '仅打开实际侧栏时不打开音乐和图片素材数据库，也不读取音频');
    doc.getElementById('materials-card').open=true;
    await until(()=>doc.getElementById('prepare-materials').disabled===false);
    assert(api.materialListReads>0,'首次展开备选图片才查询素材列表');
    doc.getElementById('materials-card').open=false;
    await until(()=>doc.getElementById('material-list').children.length===0);
    assert(doc.getElementById('material-list').children.length===0,'收起备选图片区后释放缩略图节点');
    const original = await listMusic(); if (original.length > 10) throw new Error('请保留至少两个音乐空位；本检查不会删除原有音乐。');
    oldPreferences = await getMusicPreferences(); const file = tone(), input = doc.getElementById('music-files');
    doc.getElementById('music-card').open = true;
    await until(()=>doc.getElementById('music-import').disabled===false);
    assert(api.musicFileReads===0,'展开音乐只读取元数据，没有提前读取音频文件');
    const transfer = new frame.contentWindow.DataTransfer(); transfer.items.add(new frame.contentWindow.File([file], file.name, { type: file.type }));
    input.files = transfer.files; input.dispatchEvent(new frame.contentWindow.Event('change'));
    await until(() => !doc.getElementById('music-import').disabled && /已收藏 1 首/.test(doc.getElementById('music-status').textContent));
    const music = (await listMusic()).find(item => item.name === file.name); if (!music) throw new Error('音乐未保存'); ownedMusic.add(music.id);
    // A prior selection is intentionally preserved by imports. Select this test song.
    doc.getElementById('music-select').value = music.id; doc.getElementById('music-select').dispatchEvent(new frame.contentWindow.Event('change'));
    await until(() => !doc.getElementById('music-play').disabled);
    assert(music.duration > 2.9 && !('blob' in music) && (await getMusicFile(music.id)).size > 0, '音乐仅元数据进入列表，压缩文件独立保存在本机');
    assert((await getMusicPreferences()).id === music.id && doc.getElementById('music-enabled').checked, '选择音乐后保存设置，可随录制加入');
    assert(api.musicFileReads===0,'选中音乐不会自动载入音频，等待用户试听');
    doc.getElementById('music-play').click(); await until(() => api.players.some(player => !player.paused) && !doc.getElementById('start').disabled);
    assert(api.acquired.length === 0 && api.contexts.length === 0, '试听只使用侧栏播放器，不启动录屏或录制音频上下文');
    doc.getElementById('audio').checked = false; doc.getElementById('microphone').checked = false;
    const start = async format => {
      doc.getElementById('format').value = format; doc.getElementById('start').click();
      await until(() => doc.getElementById('range-dialog').open); doc.getElementById('record-full').click();
      await until(() => api.lastState.status === 'recording'); ownedVideos.add(api.lastState.id); return api.lastState.id;
    };
    const first = await start('webm');
    assert(doc.getElementById('error').hidden, '试听刚开始就录制，正常中止试听不显示播放失败');
    assert(api.encodedAudioTracks.at(-1) === 1 && api.lastState.performance.audio.mode === 'mixed', '关闭网页声音和麦克风后，音乐仍以单条混音音轨进入视频');
    assert(api.players.filter(player => !player.paused).length === 1 && api.contexts.filter(context => context.state !== 'closed').length === 1, '开始录制先停止试听，只保留一个音乐播放器和一个混音上下文');
    await wait(650); doc.getElementById('pause').click(); await until(() => api.lastState.status === 'paused' && !api.lastState.music.playing);
    assert(api.players.every(player => player.paused), '暂停录制时音乐一起暂停');
    doc.getElementById('pause').click(); await until(() => api.lastState.status === 'recording' && api.lastState.music.playing);
    assert(api.lastState.music.playing, '继续录制时恢复音乐播放');
    doc.getElementById('music-play').click(); await until(() => !api.lastState.music.playing);
    assert(api.lastState.status === 'recording', '单独暂停音乐不会暂停视频录制');
    doc.getElementById('music-main').click(); await until(() => api.lastState.music.volume === .85);
    doc.getElementById('music-loop').checked = false; doc.getElementById('music-loop').dispatchEvent(new frame.contentWindow.Event('change'));
    await until(() => api.lastState.music.loop === false); doc.getElementById('music-restart').click();
    await until(() => api.lastState.music.playing);
    assert(api.lastState.music.volume === .85 && !api.lastState.music.loop, '主旋律预设、音量与循环设置实际传递到录制播放器');
    await wait(650); doc.getElementById('stop').click(); await until(() => ['complete', 'interrupted', 'error'].includes(api.lastState.status));
    assert(api.lastState.status === 'complete' && api.acquired.every(stream => stream.getTracks().every(track => track.readyState === 'ended')) && api.contexts.every(context => context.state === 'closed'), '停止后保存视频并释放采集与混音上下文');
    await until(() => !/正在保存视频/.test(doc.getElementById('music-status').textContent));
    assert(!/正在保存视频/.test(doc.getElementById('music-status').textContent), '结束后音乐状态退出保存中，不保留过期提示');
    assert((await getRecording(first)).music.id === music.id && await audioRMS(first) > .005, '真实 WebM 成片可解码，并测得已录入的音乐声音');
    if (isRecordingFormatSupported('mp4')) {
      const second = await start('mp4'); await wait(1100); doc.getElementById('stop').click();
      await until(() => api.lastState.status === 'complete');
      assert((await getRecording(second)).format === 'mp4' && await audioRMS(second) > .005, '原生 MP4 成片同样含有音乐音轨并能真实解码');
    } else result.textContent += '\nSKIP 当前环境不支持原生 MP4';
    const prepared = await prepareMusicFile(file); let all = await listMusic();
    while (all.length < 11) { const record = await saveMusic({ ...prepared, name: '容量测试音' }); fills.push(record.id); all.push(record); }
    const competing = await Promise.allSettled([saveMusic({ ...prepared, name: '最后空位 A' }), saveMusic({ ...prepared, name: '最后空位 B' })]);
    for (const item of competing) if (item.status === 'fulfilled') fills.push(item.value.id);
    assert(competing.filter(item => item.status === 'fulfilled').length === 1 && (await listMusic()).length === 12, '真实 IndexedDB 并发写入不突破12首收藏上限');
    for (const id of fills) await deleteMusic(id); fills = [];
    assert((await getRecording(first)).bytes > 0, '音乐收藏与已保存的视频独立，不修改视频原件');
    result.textContent += `\n\n全部通过（${passed}项）。Chrome 原生采集与离屏权限仍需实机验证。`;
  } catch (error) { result.textContent += `\nFAIL ${error.stack || error.message}\n诊断：${JSON.stringify({ options: api?.startOptions?.music, audioTracks: api?.encodedAudioTracks, audio: api?.lastState?.performance?.audio })}`; }
  finally {
    for (const id of fills) await deleteMusic(id);
    if (api && ['preparing', 'recording', 'paused'].includes(api.lastState.status)) frame.contentDocument.getElementById('stop').click();
    run.disabled = false;
  }
};
