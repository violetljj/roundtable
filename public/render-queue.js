// 每帧只处理一批最新消息；切换房间后，迟到的旧帧也不能刷新新页面。
export function createRenderQueue({
  render,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (id) => globalThis.cancelAnimationFrame(id),
  keyOf = (message) => message.id,
}) {
  const pending = new Map();
  let frame = null;
  let generation = 0;

  function enqueue(message) {
    pending.set(keyOf(message), message);
    if (frame !== null) return;
    const scheduledGeneration = generation;
    frame = requestFrame(() => {
      if (scheduledGeneration !== generation) return;
      frame = null;
      const batch = [...pending.values()];
      pending.clear();
      // 先取走当前批次，渲染期间新增的更新留到下一帧。
      if (batch.length) render(batch);
    });
  }

  function clear() {
    generation++;
    if (frame !== null) cancelFrame(frame);
    frame = null;
    pending.clear();
  }

  return { enqueue, clear };
}
