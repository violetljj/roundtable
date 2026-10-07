// 账号查询可能要启动命令行；读取先返回缓存，慢查询只在后台运行一份。
export function createStatusCache({ load, ttlMs, retryMs = 15000, now = Date.now, onValue = () => {} }) {
  let value = null;
  let updatedAt = null;
  let nextAttemptAt = -Infinity;
  let error = null;
  let pending = null;

  function refresh(force = false) {
    if (pending) return pending;
    if (!force && now() < nextAttemptAt) return Promise.resolve();
    pending = Promise.resolve().then(load).then((result) => {
      onValue(result);
      value = result;
      updatedAt = now();
      nextAttemptAt = updatedAt + ttlMs;
      error = null;
    }).catch((err) => {
      // 失败保留上一次数据，并退避，避免多个页面反复拉起查询。
      error = err?.message ?? String(err);
      nextAttemptAt = now() + retryMs;
    }).finally(() => { pending = null; });
    return pending;
  }

  function read() {
    void refresh();
    return { value, updatedAt, error, refreshing: pending !== null };
  }

  return { read, refresh };
}
