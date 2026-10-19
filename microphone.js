document.getElementById('grant').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    document.getElementById('status').textContent = '授权成功。现在可以关闭本页，回到项目网页继续。';
  } catch (error) { document.getElementById('status').textContent = `未获得授权：${error.message}`; }
};
