const ENABLED_KEY = 'roundtable:notifications:enabled';
const SEEN_KEY = 'roundtable:notifications:seen';
const MAX_EVENTS = 512;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// 浏览器存储不可用时仍在本页去重；跨页是尽力去重，不充当分布式锁。
export function createEventLedger(storage, now = Date.now) {
  let local = [];
  return (key) => {
    const at = now();
    let saved = [];
    try {
      const value = JSON.parse(storage?.getItem(SEEN_KEY) || '[]');
      if (Array.isArray(value)) saved = value;
    } catch {}
    const entries = new Map([...saved, ...local]
      .filter((row) => Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && at - row[1] < MAX_AGE));
    const fresh = !entries.has(key);
    entries.set(key, at);
    local = [...entries].sort((a, b) => a[1] - b[1]).slice(-MAX_EVENTS);
    try { storage?.setItem(SEEN_KEY, JSON.stringify(local)); } catch {}
    return fresh;
  };
}

function failureNotice(state) {
  return state?.status === 'paused' && /出错|失败/.test(state.notice || '');
}

function stateStamp(state, lastMessage) {
  return [lastMessage || '', state.phase, state.round, state.turnInRound,
    state.usage?.claude?.turns, state.usage?.codex?.turns].join(':');
}

// 纯事件跟踪器，导入模块不会访问浏览器全局对象。
export function createNotificationTracker({ emit, claim = () => true }) {
  const rooms = new Map();
  function remember(id, record) {
    rooms.delete(id);
    rooms.set(id, record);
    if (rooms.size > 64) rooms.delete(rooms.keys().next().value);
  }
  function send(id, record, kind, detail, suffix) {
    const key = JSON.stringify([id, kind, suffix]);
    if (claim(key)) emit({ roomId: id, kind, key, topic: record.state.topic || '圆桌讨论', detail });
  }
  return {
    observe(id, previous, state) {
      if (!id || !state) return;
      let record = rooms.get(id);
      // snapshot 既用于首次打开也用于重连，不补发历史事件。
      if (!record || !previous) {
        const messages = Array.isArray(state.messages) ? state.messages : [];
        record = { state: { ...state }, lastMessage: messages.at(-1)?.id || record?.lastMessage,
          failureReported: failureNotice(state), completed: state.phase === 'done' };
        remember(id, record);
        return;
      }
      const before = record.state;
      record.state = { ...state };
      if (state.status === 'running' && before.status !== 'running') record.failureReported = false;
      if (state.phase !== 'done') record.completed = false;
      const stamp = stateStamp(state, record.lastMessage);
      if (state.status === 'waiting' && state.phase !== 'done' && (before.status !== 'waiting' || before.phase === 'done')) {
        send(id, record, 'waiting', '有问题需要你回答，点击回到讨论。', stamp);
      } else if (state.phase === 'done' && state.status === 'waiting' && !record.completed) {
        record.completed = true;
        send(id, record, 'done', '总结与复核已完成，点击查看结论。', stamp);
      } else if (state.status === 'paused' && state.capHit && /已达到.*上限/.test(state.notice || '') && (before.status !== 'paused' || !before.capHit || before.notice !== state.notice)) {
        send(id, record, 'cap', '已达到本场发言上限，点击调整上限或总结。', stamp);
      } else if (failureNotice(state) && !record.failureReported && (!failureNotice(before) || before.notice !== state.notice)) {
        record.failureReported = true;
        send(id, record, 'failed', '讨论遇到错误，点击查看详情并决定是否重试。', stamp + ':' + state.notice);
      }
      remember(id, record);
    },
    observeMessage(id, message) {
      const record = rooms.get(id);
      if (!record || !message?.id) return;
      if (message.status === 'streaming' && record.lastMessage !== message.id) record.failureReported = false;
      record.lastMessage = message.id;
      if (message.status !== 'failed') return;
      record.failureReported = true;
      send(id, record, 'failed', `${message.from === 'claude' ? 'Claude' : message.from === 'codex' ? 'Codex' : '一条发言'} 发言失败，点击查看详情。`, message.id);
    },
    clear() { rooms.clear(); },
  };
}

export function initNotifications({ openRoom, window: win = globalThis.window, document: doc = globalThis.document } = {}) {
  if (!win || !doc) return { observe() {}, observeMessage() {}, dispose() {} };
  let storage;
  try { storage = win.localStorage; } catch {}
  const NotificationAPI = win.Notification;
  const supported = typeof NotificationAPI === 'function';
  let enabled = false;
  try { enabled = storage?.getItem(ENABLED_KEY) === 'true'; } catch {}
  let disposed = false;
  const active = new Set();
  const panel = doc.createElement('div');
  panel.id = 'desktopNotifications';
  panel.className = 'notify';
  const button = doc.createElement('button');
  button.className = 'notify-btn';
  button.type = 'button';
  const hint = doc.createElement('div');
  hint.className = 'notify-hint';
  hint.setAttribute('aria-live', 'polite');
  panel.append(button, hint);
  const sidebar = doc.getElementById('sidebar');
  const accounts = doc.getElementById('accounts');
  if (sidebar) (accounts?.parentNode ?? sidebar).insertBefore(panel, accounts);

  function render(problem = '') {
    const permission = supported ? NotificationAPI.permission : 'unavailable';
    const on = enabled && permission === 'granted';
    button.textContent = `桌面通知：${!supported ? '不可用' : permission === 'denied' ? '被浏览器阻止' : on ? '已开启' : '未开启'}`;
    button.setAttribute('aria-pressed', String(on));
    button.disabled = !supported || permission === 'denied';
    hint.textContent = problem || (!supported ? '当前浏览器不支持桌面通知。' : permission === 'denied'
      ? '请在浏览器的网站权限中允许通知，再点击开启。' : '仅通知当前打开的讨论；关闭页面后不通知。');
  }
  function saveEnabled(value) {
    enabled = value;
    try { storage?.setItem(ENABLED_KEY, String(value)); } catch {}
  }
  button.onclick = async () => {
    if (!supported || disposed) return;
    if (enabled && NotificationAPI.permission === 'granted') { saveEnabled(false); render(); return; }
    button.disabled = true;
    try {
      const permission = NotificationAPI.permission === 'default'
        ? await NotificationAPI.requestPermission() : NotificationAPI.permission;
      if (disposed) return;
      saveEnabled(permission === 'granted');
      render(permission === 'default' ? '未授予权限。需要时可再次点击开启；关闭页面后不通知。' : '');
    } catch {
      saveEnabled(false);
      render('当前浏览器未能开启通知，可稍后重试。关闭页面后不通知。');
    }
  };
  function sync(event) {
    if (event.type === 'storage' && event.key !== ENABLED_KEY) return;
    try { enabled = storage?.getItem(ENABLED_KEY) === 'true'; } catch {}
    render();
  }
  win.addEventListener('storage', sync);
  win.addEventListener('focus', sync);
  const titles = { waiting: '需要你回答', done: '讨论已完成', cap: '讨论达到上限', failed: '讨论遇到错误' };
  const ledger = createEventLedger(storage);
  const tracker = createNotificationTracker({
    claim: (key) => !disposed && enabled && supported && NotificationAPI.permission === 'granted' && ledger(key),
    emit(event) {
      if (disposed || !enabled || !supported || NotificationAPI.permission !== 'granted') return;
      try {
        const notification = new NotificationAPI(`${titles[event.kind]} · 圆桌`, {
          body: `${event.topic.slice(0, 90)}\n${event.detail}`, tag: event.key,
        });
        active.add(notification);
        notification.onclose = () => active.delete(notification);
        notification.onclick = () => {
          win.focus();
          openRoom?.(event.roomId);
          notification.close();
          active.delete(notification);
        };
      } catch { render('浏览器未能显示通知，请检查网站权限与系统通知设置。'); }
    },
  });
  render();
  return {
    observe: tracker.observe,
    observeMessage: tracker.observeMessage,
    dispose() {
      disposed = true;
      tracker.clear();
      win.removeEventListener('storage', sync);
      win.removeEventListener('focus', sync);
      for (const notification of active) notification.close();
      active.clear();
      panel.remove();
    },
  };
}
