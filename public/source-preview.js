export function initSourcePreview({ api, getCurrent }) {
  const dialog = document.createElement('dialog');
  dialog.style.cssText = 'width:min(850px,calc(100vw - 24px));max-height:85vh;overflow:auto;padding:20px';
  const title = document.createElement('h3');
  title.textContent = '来源预览';
  const notice = document.createElement('p');
  notice.className = 'fine';
  const metadata = document.createElement('p');
  metadata.className = 'fine';
  metadata.style.overflowWrap = 'anywhere';
  const pre = document.createElement('pre');
  pre.style.cssText = 'overflow:auto;max-height:50vh;padding:12px;background:var(--panel-2);font:13px/1.7 var(--mono)';
  const close = document.createElement('button');
  close.className = 'btn';
  close.textContent = '关闭';
  close.onclick = () => dialog.close();
  dialog.append(title, notice, metadata, pre, close);
  document.body.append(dialog);
  let request = 0;
  return async function openSource(reference) {
    const roomId = getCurrent()?.id;
    if (!roomId) return;
    const ticket = ++request;
    title.textContent = '来源预览';
    notice.textContent = '正在读取当前项目文件…';
    metadata.textContent = reference;
    pre.textContent = '';
    if (!dialog.open) dialog.showModal();
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/source?reference=${encodeURIComponent(reference)}`);
      if (ticket !== request || getCurrent()?.id !== roomId || !dialog.open) return;
      title.textContent = `${data.file}:${data.line}`;
      notice.textContent = data.notice;
      metadata.textContent = `当前内容 SHA-256：${data.sha256} · 读取于 ${new Date(data.readAt).toLocaleString('zh-CN')}`;
      pre.textContent = data.lines.map((s, i) => `${i + data.start === data.line ? '›' : ' '} ${String(i + data.start).padStart(4)}  ${s}`).join('\n');
    } catch (error) {
      if (ticket === request && getCurrent()?.id === roomId && dialog.open) notice.textContent = error.message;
    }
  };
}
