'use strict';

const $ = (s) => document.querySelector(s);
const NAMES = { claude: 'Claude', codex: 'Codex', user: '你' };
const LETTER = { claude: 'C', codex: 'X', user: '你' };

let current = null; // { id, state, msgs: Map }
let es = null;
let target = 'all';

// 执行交接独立加载，避免给讨论消息渲染增加状态。
const handoffUI = import('/handoff.js').then(({ initHandoff }) => initHandoff({ api, getCurrent: () => current }));

// ---------- API ----------
async function api(path, body) {
  const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `请求失败（${r.status}）`);
  return data;
}

// ---------- 讨论列表 ----------
// 讨论按项目分组，和桌面端一样；最近有动静的项目排在前面
function collapsedGroups() {
  try { return new Set(JSON.parse(localStorage.getItem('roundtable:collapsed') ?? '[]')); } catch { return new Set(); }
}
function setCollapsed(set) {
  try { localStorage.setItem('roundtable:collapsed', JSON.stringify([...set])); } catch {}
}

async function loadRooms() {
  const rooms = await api('/api/rooms').catch(() => []);
  const groups = new Map();
  for (const r of rooms) {
    const k = (r.cwd ?? '').toLowerCase();
    if (!groups.has(k)) groups.set(k, { cwd: r.cwd ?? '', rooms: [] });
    groups.get(k).rooms.push(r);
  }
  const sorted = [...groups.values()].map((g) => ({ ...g, rooms: g.rooms.sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => b.rooms[0].updatedAt - a.rooms[0].updatedAt);
  const collapsed = collapsedGroups();
  const ul = $('#roomList');
  ul.innerHTML = '';
  for (const g of sorted) {
    const name = g.cwd.split(/[\\/]/).filter(Boolean).pop() || g.cwd || '未分类';
    const k = g.cwd.toLowerCase();
    const isOpen = !collapsed.has(k) || g.rooms.some((r) => r.id === current?.id);
    const head = document.createElement('li');
    head.className = 'group';
    head.innerHTML = `<div class="group-row"><button class="group-btn" aria-expanded="${isOpen}"><span class="caret-i">${isOpen ? '▾' : '▸'}</span><span class="g-name"></span><span class="g-count">${g.rooms.length}</span></button><button class="g-add" title="在这个项目里新建讨论" aria-label="在这个项目里新建讨论">＋</button></div>`;
    head.querySelector('.g-name').textContent = name;
    head.title = g.cwd;
    head.querySelector('.g-add').onclick = () => { pendingProject = g.cwd; toggleSidebar(false); openNewDialog(); };
    head.querySelector('.group-btn').onclick = () => {
      const c = collapsedGroups();
      if (c.has(k)) c.delete(k); else c.add(k);
      setCollapsed(c);
      loadRooms();
    };
    ul.appendChild(head);
    if (!isOpen) continue;
    for (const r of g.rooms) {
      const li = document.createElement('li');
      li.className = 'room-item' + (current?.id === r.id ? ' active' : '');
      // 侧栏状态点：进行中 / 暂停 / 等你回答 / 结束
      li.dataset.status = r.status === 'waiting' && r.phase !== 'done' ? 'waiting-user' : r.status;
      li.innerHTML = `<span class="t"></span><span class="s"></span>`;
      li.querySelector('.t').textContent = r.topic;
      li.querySelector('.s').textContent = `${new Date(r.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${statusText(r)}`;
      li.onclick = () => { openRoom(r.id); toggleSidebar(false); };
      ul.appendChild(li);
    }
  }
  return rooms;
}

function statusText(r) {
  if (r.status === 'running') return '进行中';
  if (r.status === 'paused') return '已暂停';
  if (r.status === 'waiting') return r.phase === 'done' ? '已结束' : '等你发言';
  if (r.status === 'stopped') return '已停止';
  return '已结束';
}

async function loadHealth() {
  try {
    const h = await api('/api/health');
    $('#cwdInput').placeholder = h.cwd;
    $('#cwdInput').dataset.default = h.cwd;
    if (h.claude !== 'ok') setAcct('claude', null, `<span class="bad">${esc(h.claude)}</span>`);
    if (h.codex !== 'ok') setAcct('codex', null, `<span class="bad">${esc(h.codex)}</span>`);
  } catch {
    setAcct('claude', null, '<span class="bad">服务未连接</span>');
    setAcct('codex', null, '<span class="bad">服务未连接</span>');
  }
}

// ---------- 账号与额度 ----------
const PLAN = { pro: 'Pro', max: 'Max', plus: 'Plus', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
function planName(p) { return p ? (PLAN[String(p).toLowerCase()] ?? p) : ''; }

function setAcct(who, plan, html) {
  const el = document.getElementById(who === 'claude' ? 'acctClaude' : 'acctCodex');
  el.querySelector('.plan').textContent = planName(plan);
  el.querySelector('.acct-body').innerHTML = html;
}

function meter(label, ratio, resetsAt) {
  // 已经过了重置时间：旧的百分比没有意义了
  if (resetsAt && resetsAt * 1000 <= Date.now()) {
    return `<div class="meter"><span>${label}</span><span class="bar"><i style="width:0"></i></span><span class="pct">—</span></div>` +
      `<div class="sub" style="padding-left:50px">已重置，下次发言后更新</div>`;
  }
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const cls = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : '';
  const reset = resetsAt ? `${fmtReset(resetsAt)} 重置` : '';
  return `<div class="meter" title="${esc(reset)}"><span>${label}</span><span class="bar"><i class="${cls}" style="width:${pct}%"></i></span><span class="pct">${pct}%</span></div>` +
    (reset ? `<div class="sub" style="padding-left:50px">${esc(reset)}</div>` : '');
}

function fmtReset(sec) {
  const d = new Date(sec * 1000);
  const diff = d - Date.now();
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h ? h + ' 小时 ' : ''}${Math.ceil((diff % 3600000) / 60000)} 分钟后`;
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function windowName(mins) {
  if (!mins) return '额度';
  if (mins % 1440 === 0) return `${mins / 1440} 天`;
  if (mins % 60 === 0) return `${mins / 60} 小时`;
  return `${mins} 分`;
}

function renderStatus(s) {
  // Claude
  const ca = s.claude.account;
  let html = '';
  if (ca && !ca.loggedIn) html += '<span class="bad">命令行未登录</span>';
  else if (ca) html += `<div class="email" title="${esc(ca.email ?? '')}">${esc(ca.email ?? '已登录')}</div>`;
  const lim = s.claude.limits;
  if (lim?.unifiedWindows) {
    const w = lim.unifiedWindows;
    if (w.five_hour) html += meter('5 小时', w.five_hour.utilization, w.five_hour.resetsAt);
    if (w.seven_day) html += meter('7 天', w.seven_day.utilization, w.seven_day.resetsAt);
    for (const [k, v] of Object.entries(w)) if (!['five_hour', 'seven_day'].includes(k)) html += meter(k.replace(/_/g, ' '), v.utilization, v.resetsAt);
    if (lim.isUsingOverage) html += '<div class="bad">正在使用超额额度</div>';
    html += `<div class="sub">${new Date(lim.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新 · <button class="link" data-probe>立即刷新</button></div>`;
  } else {
    html += `<div class="sub">${s.claude.probing ? '正在读取额度…' : '还没有额度数据，Claude 发言后自动显示'} · <button class="link" data-probe>立即读取</button></div>`;
  }
  setAcct('claude', ca?.plan, html);

  // Codex
  const xa = s.codex.account;
  const rl = s.codex.rateLimits;
  html = '';
  if (s.codex.error) html += `<span class="bad">${esc(s.codex.error)}</span>`;
  if (xa) html += `<div class="email" title="${esc(xa.email ?? '')}">${esc(xa.email ?? xa.type ?? '已登录')}</div>`;
  else if (!s.codex.error) html += '<span class="bad">未登录</span>';
  if (rl?.primary) html += meter(windowName(rl.primary.windowDurationMins), rl.primary.usedPercent / 100, rl.primary.resetsAt);
  if (rl?.secondary) html += meter(windowName(rl.secondary.windowDurationMins), rl.secondary.usedPercent / 100, rl.secondary.resetsAt);
  if (rl?.credits && !rl.credits.unlimited && rl.credits.balance != null) html += `<div class="sub">积分余额 ${Number(rl.credits.balance).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}</div>`;
  if (rl?.rateLimitReachedType) html += '<div class="bad">已达到额度上限</div>';
  setAcct('codex', xa?.planType ?? rl?.planType, html);
}

async function loadStatus() {
  try { renderStatus(await api('/api/status')); } catch {}
}

document.getElementById('accounts').addEventListener('click', async (e) => {
  if (e.target.matches('[data-probe]')) {
    if (!confirm('读取 Claude 额度需要发一条极小的请求（Haiku 模型，一句话），会消耗很少的额度。继续？')) return;
    e.target.textContent = '读取中…';
    try { renderStatus(await api('/api/status/refresh-claude', {})); } catch (err) { alert(err.message); }
  }
});
// 按钮放在折叠标题里：点它只刷新，不折叠面板
$('#refreshStatus').onclick = (e) => { e.preventDefault(); e.stopPropagation(); loadStatus(); };
try { if (localStorage.getItem('roundtable:accounts') === 'closed') $('#accounts').open = false; } catch {}
$('#accounts').addEventListener('toggle', () => {
  try { localStorage.setItem('roundtable:accounts', $('#accounts').open ? 'open' : 'closed'); } catch {}
});

// ---------- 模型选择 ----------
let models = null;
async function loadModels() {
  if (!models) {
    models = await api('/api/models').catch(() => null);
    const s = current?.state;
    if (models && s?.models) {
      $('#chipClaude').textContent = modelLabel('claude', s.models.claude);
      $('#chipCodex').textContent = modelLabel('codex', s.models.codex);
    }
  }
  return models;
}

const EFFORT_NAME = { low: '低 low', medium: '中 medium', high: '高 high', xhigh: '很高 xhigh', max: '最高 max', ultra: '极限 ultra' };

async function renderPicker(container, value) {
  const m = await loadModels();
  const v = value ?? { claude: { model: 'sonnet', effort: '' }, codex: { model: '', effort: '' } };
  const cm = m?.claude.models ?? [{ id: 'sonnet', name: 'Sonnet' }];
  const xm = m?.codex.models ?? [];
  container.innerHTML = `
    <div class="mp-row"><span class="who-l"><span class="dot sm claude">C</span>Claude</span>
      <select data-k="claude.model" aria-label="Claude 模型">${cm.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select>
      <select data-k="claude.effort" aria-label="Claude 推理强度"></select></div>
    <div class="mp-note" data-note="claude"></div>
    <div class="mp-row"><span class="who-l"><span class="dot sm codex">X</span>Codex</span>
      <select data-k="codex.model" aria-label="Codex 模型"><option value="">跟随 Codex 设置</option>${xm.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.isDefault ? '（推荐）' : ''}</option>`).join('')}</select>
      <select data-k="codex.effort" aria-label="Codex 推理强度"></select></div>`;
  const sel = (k) => container.querySelector(`[data-k="${k}"]`);
  const fillEfforts = (who) => {
    const modelId = sel(`${who}.model`).value;
    const list = who === 'claude' ? (m?.claude.efforts ?? []) : (xm.find((x) => x.id === modelId)?.efforts ?? ['low', 'medium', 'high', 'xhigh']);
    const def = who === 'codex' ? xm.find((x) => x.id === modelId)?.defaultEffort : null;
    const keep = sel(`${who}.effort`).value || v[who].effort;
    sel(`${who}.effort`).innerHTML = `<option value="">默认强度${def ? `（${def}）` : ''}</option>` + list.map((e) => `<option value="${e}">${EFFORT_NAME[e] ?? e}</option>`).join('');
    sel(`${who}.effort`).value = list.includes(keep) ? keep : '';
    if (who === 'claude') {
      const note = { opus: 'Opus 能力更强，但消耗 Pro 额度明显更快', fable: 'Fable 消耗额度最快，你的套餐不一定支持', haiku: 'Haiku 最省额度，适合简单问题' }[modelId] ?? '';
      container.querySelector('[data-note="claude"]').textContent = note;
    }
  };
  sel('claude.model').value = v.claude.model;
  sel('codex.model').value = v.codex.model;
  if (sel('codex.model').value !== v.codex.model) sel('codex.model').value = '';
  fillEfforts('claude');
  fillEfforts('codex');
  sel('claude.model').onchange = () => fillEfforts('claude');
  sel('codex.model').onchange = () => fillEfforts('codex');
}

function readPicker(container) {
  const g = (k) => container.querySelector(`[data-k="${k}"]`)?.value ?? '';
  return { claude: { model: g('claude.model'), effort: g('claude.effort') }, codex: { model: g('codex.model'), effort: g('codex.effort') } };
}

function modelLabel(who, v) {
  const list = who === 'claude' ? models?.claude.models : models?.codex.models;
  const name = list?.find((x) => x.id === v.model)?.name ?? (v.model || (who === 'codex' ? 'Codex 默认' : '默认'));
  return `${who === 'claude' ? 'Claude' : 'Codex'} · ${name}${v.effort ? ' · ' + v.effort : ''}`;
}

// ---------- 打开讨论室 ----------
function openRoom(id) {
  es?.close();
  current = { id, state: null, msgs: new Map() };
  handoffUI.then((ui) => ui.sync(current));
  try { localStorage.setItem('roundtable:last', id); } catch {}
  $('#emptyState').classList.add('hidden');
  $('#menuBtn2').classList.add('hidden');
  $('#roomView').classList.remove('hidden');
  $('#jumpSummaryBtn').classList.add('hidden');
  $('#timeline').innerHTML = '';
  $('#exportBtn').href = `/api/rooms/${id}/transcript`;
  es = new EventSource(`/api/rooms/${id}/events`);
  es.onmessage = (e) => handleEvent(JSON.parse(e.data));
  loadRooms();
}

function handleEvent(ev) {
  if (!current) return;
  switch (ev.type) {
    case 'snapshot': {
      const { messages, ...state } = ev.room;
      current.msgs.clear();
      $('#timeline').innerHTML = '';
      current.state = state; // 消息渲染要用到阶段信息
      for (const m of messages) current.msgs.set(m.id, m);
      for (const m of messages) upsertMsg(m, false);
      current.state = null;
      setState(state);
      // 重连可能错过交接完成事件，重新读取独立状态；保留未保存的任务卡编辑。
      handoffUI.then((ui) => ui.refresh());
      scrollToBottom(true);
      break;
    }
    case 'msg': upsertMsg(ev.msg, true); break;
    case 'delta': {
      const m = current.msgs.get(ev.id);
      if (!m) return;
      m.text += ev.text;
      scheduleRender(m);
      break;
    }
    case 'activity': {
      const m = current.msgs.get(ev.id);
      if (!m) return;
      m.activity.push(ev.label);
      scheduleRender(m);
      break;
    }
    case 'state':
      setState(ev.state);
      break;
    case 'handoff': {
      const roomId = current.id;
      handoffUI.then((ui) => ui.update(roomId, ev.handoff));
      break;
    }
  }
}

// ---------- 状态栏 ----------
function setState(s) {
  const prev = current.state;
  current.state = s;
  handoffUI.then((ui) => ui.sync(current));
  $('#roomTopic').textContent = s.topic;
  $('#roomTopic').title = s.topic;
  document.title = `${s.topic} · 圆桌讨论室`;

  let phase;
  if (s.phase === 'independent') phase = '第 0 轮 · 独立提案';
  else if (s.phase === 'discussion') phase = `交叉讨论 · 第 ${Math.min(s.round, s.maxRounds)}/${s.maxRounds} 轮`;
  else if (s.phase === 'summary') phase = '整理总结';
  else if (s.phase === 'review') phase = '总结复核';
  else if (s.phase === 'finalize') phase = '合并定稿';
  else phase = '讨论结束 · 自由问答';
  $('#phasePill').textContent = phase;
  if (s.models) {
    $('#chipClaude').textContent = modelLabel('claude', s.models.claude);
    $('#chipCodex').textContent = modelLabel('codex', s.models.codex);
  }
  $('#modePill').textContent = MODE_NAMES[s.mode] ?? '做决定';
  const f = s.facts ?? { version: 0, text: '' };
  $('#factsChip').textContent = f.text ? `约束卡 v${f.version}` : '＋ 约束卡';
  $('#factsChip').classList.toggle('empty', !f.text);
  const turns = (s.usage?.claude.turns ?? 0) + (s.usage?.codex.turns ?? 0);
  $('#usageChip').textContent = `本场 ${turns}${s.maxTurns ? '/' + s.maxTurns : ''} 次 · ${fmtDuration(Date.now() - s.createdAt)}`;
  if ($('#usageDialog').open) renderUsage(s);
  // 一次发言结束后，额度会变化
  if (prev && prev.speaking.length > s.speaking.length) setTimeout(loadStatus, 1500);

  const sp = $('#speaking');
  sp.innerHTML = '';
  if (s.speaking.length) {
    for (const a of s.speaking) {
      const span = document.createElement('span');
      span.className = 'speaking';
      span.innerHTML = `<span class="pulse" style="background:var(--${a})"></span>${NAMES[a]} 正在发言`;
      sp.appendChild(span);
    }
  } else {
    sp.textContent = { running: '', paused: '已暂停', waiting: s.phase === 'done' ? '' : '等你发言', stopped: '已停止', done: '' }[s.status] ?? '';
  }

  const notice = $('#notice');
  notice.textContent = s.notice || '';
  notice.classList.toggle('hidden', !s.notice);
  // 讨论正常结束、等你提问这类提示用中性样式；暂停、出错、达到上限才用警示色
  notice.classList.toggle('info', s.status === 'waiting' && s.phase === 'done');

  const active = ['independent', 'discussion'].includes(s.phase);
  $('#pauseBtn').classList.toggle('hidden', s.status !== 'running');
  $('#resumeBtn').classList.toggle('hidden', !(s.status === 'paused' || (s.status === 'waiting' && s.phase !== 'done')));
  $('#interruptBtn').classList.toggle('hidden', !s.speaking.length);
  $('#addRoundBtn').disabled = !active;
  $('#finishBtn').classList.toggle('hidden', !active);
  $('#stopBtn').disabled = s.status === 'stopped' || (s.phase === 'done' && !s.speaking.length);
  updateHint();
  if (!prev || prev.status !== s.status || prev.phase !== s.phase) loadRooms();
}

function updateHint() {
  const s = current?.state;
  const urgent = $('#urgentChk').checked;
  let hint = '默认排在当前发言之后。Enter 发送，Shift+Enter 换行';
  if (urgent) hint = 'Claude 正在说的话会被打断并按你的纠正重来；Codex 不打断，直接把你的话插进去';
  else if (s && s.status !== 'running') hint = '发送后讨论会继续';
  if (target !== 'all') hint = `${NAMES[target]} 会优先回答你。` + hint;
  $('#composerHint').textContent = hint;
}

// ---------- 模式、约束卡、本场用量 ----------
const MODE_NAMES = { decide: '做决定', brainstorm: '探索想法', review: '方案审查' };

function fmtDuration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  return `${Math.floor(m / 1440)} 天`;
}

function fmtTokens(n) {
  if (!n) return '0';
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
}

function renderUsage(s) {
  const u = s.usage;
  const row = (who) => {
    const x = u[who];
    return `<span>${NAMES[who]}</span><span class="n">${x.turns}</span><span class="n">${fmtTokens(x.input)}</span><span class="n opt">${fmtTokens(x.cached)}</span><span class="n">${fmtTokens(x.output)}</span><span class="n opt">${fmtDuration(x.ms)}</span>`;
  };
  $('#usageTable').innerHTML =
    '<span class="h"></span><span class="h n">发言</span><span class="h n">输入</span><span class="h n opt">其中缓存</span><span class="h n">输出</span><span class="h n opt">耗时</span>' +
    row('claude') + row('codex');
}

$('#factsChip').onclick = () => {
  const s = current?.state;
  if (!s) return;
  const f = s.facts ?? { version: 0, text: '', history: [] };
  $('#factsVer').textContent = f.version ? `当前 v${f.version}` : '（还没有）';
  $('#factsText').value = f.text;
  const hist = $('#factsHistory');
  hist.classList.toggle('hidden', !f.history?.length);
  hist.querySelector('div').innerHTML = (f.history ?? []).slice().reverse()
    .map((h) => `<div class="h-item"><b>v${h.version}</b>（已作废）\n${esc(h.text || '（空）')}</div>`).join('');
  $('#factsDialog').showModal();
  $('#factsText').focus();
};
$('#cancelFacts').onclick = () => $('#factsDialog').close();
$('#factsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#factsDialog').close();
  api(`/api/rooms/${current.id}/facts`, { text: $('#factsText').value }).catch((err) => alert(err.message));
});

$('#usageChip').onclick = () => {
  const s = current?.state;
  if (!s) return;
  renderUsage(s);
  $('#setMaxTurns').value = s.maxTurns ?? 0;
  $('#setMaxRounds').value = s.maxRounds;
  $('#usageDialog').showModal();
};
$('#cancelUsage').onclick = () => $('#usageDialog').close();
$('#usageForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#usageDialog').close();
  api(`/api/rooms/${current.id}/settings`, { maxTurns: $('#setMaxTurns').value, maxRounds: $('#setMaxRounds').value }).catch((err) => alert(err.message));
});

// 你的插话是否已经送到、对方是否已经回应（"已送达"不等于"已理解"）
function deliveryHtml(m) {
  const chip = (who) => {
    if (m.answeredBy?.[who]) return `<span class="done" title="${NAMES[who]} 已经在一次完整发言里看到并回应">${NAMES[who]} 已回应</span>`;
    if (m.seenBy?.[who]) return `<span class="seen" title="已经交给 ${NAMES[who]}，它正在处理或还没说完">已送达 ${NAMES[who]}</span>`;
    return `<span title="排队中，${NAMES[who]} 下一次发言时会收到">等待送达 ${NAMES[who]}</span>`;
  };
  return `<div class="delivery">${chip('claude')}${chip('codex')}</div>`;
}

// ---------- 消息 ----------
const pending = new Set();
function scheduleRender(m) {
  pending.add(m);
  if (pending.size === 1) requestAnimationFrame(() => {
    const stick = nearBottom();
    for (const x of pending) renderMsg(x);
    pending.clear();
    if (stick) scrollToBottom();
  });
}

function upsertMsg(m, live) {
  const stick = nearBottom();
  current.msgs.set(m.id, m);
  let el = document.getElementById('m-' + m.id);
  if (!el) {
    el = document.createElement('div');
    el.id = 'm-' + m.id;
    const isPair = m.phase === 'independent' && (m.from === 'claude' || m.from === 'codex');
    if (isPair) {
      let pair = document.getElementById('pair-independent');
      if (!pair) {
        const label = document.createElement('div');
        label.className = 'pair-label';
        label.textContent = '双方同时作答，互相看不到对方的内容';
        $('#timeline').appendChild(label);
        pair = document.createElement('div');
        pair.className = 'pair';
        pair.id = 'pair-independent';
        $('#timeline').appendChild(pair);
      }
      pair.appendChild(el);
    } else {
      $('#timeline').appendChild(el);
    }
  }
  renderMsg(m);
  if (live && stick) scrollToBottom();
}

const PHASE_MARK = /^(第 0 轮|进入交叉讨论|.*进入总结|复核提出了更正|复核无异议|定稿完成|讨论结束)/;
function phaseLabel(text) {
  if (/^第 0 轮/.test(text)) return '独立提案';
  const m = text.match(/^进入交叉讨论，共 (\d+) 轮/);
  if (m) return `交叉讨论 · 共 ${m[1]} 轮`;
  if (/进入总结/.test(text)) return text.replace(/，?进入总结。?$/, '') ? `总结（${text.replace(/，?进入总结。?$/, '').replace(/。$/, '')}）` : '总结';
  if (/^复核提出了更正/.test(text)) return '合并定稿';
  if (/^复核无异议/.test(text)) return '讨论结束 · 复核无异议';
  if (/^定稿完成/.test(text)) return '讨论结束 · 已定稿';
  return '讨论结束';
}

function renderMsg(m) {
  const el = document.getElementById('m-' + m.id);
  if (!el) return;
  if (m.from === 'system') {
    // 阶段切换显示成分隔线，其他系统消息是小字备注
    el.className = PHASE_MARK.test(m.text) ? 'sys divider' : 'sys';
    el.textContent = PHASE_MARK.test(m.text) ? phaseLabel(m.text) : m.text;
    el.title = m.text;
    return;
  }
  el.className = `msg ${m.from}${m.status === 'interrupted' || m.status === 'failed' ? ' interrupted' : ''}${m.status === 'streaming' ? ' streaming' : ''}`;
  if (m.kind) el.dataset.kind = m.kind;
  const tags = [];
  if (m.from === 'user' && m.target && m.target !== 'all') tags.push(['', '@' + NAMES[m.target]]);
  if (m.urgent) tags.push(['bad', '紧急纠正']);
  if (m.kind === 'summary') tags.push(['sum', '总结']);
  if (m.kind === 'review') tags.push(['sum', '复核']);
  if (m.kind === 'final') tags.push(['sum', '定稿 · 已合并复核更正']);
  if (m.phase === 'discussion' && m.from !== 'user' && m.round) tags.push(['', `第 ${m.round} 轮`]);
  if (m.model) tags.push(['', m.model]);
  if (m.status === 'interrupted') tags.push(['bad', '被打断 · 未转发给对方']);
  if (m.status === 'failed') tags.push(['bad', '出错']);

  const time = new Date(m.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<div class="dot ${m.from}">${LETTER[m.from]}</div>
    <div class="bubble">
      <div class="who"><b>${NAMES[m.from]}</b>${tags.map(([c, t]) => `<span class="tag ${c}">${esc(t)}</span>`).join('')}<time>${time}</time></div>
      <div class="body"></div>
    </div>`;
  const body = el.querySelector('.body');
  if (m.text) body.innerHTML = md(m.text);
  else if (m.status === 'streaming') body.innerHTML = `<span class="waiting">${m.activity.length ? '' : '正在思考…'}</span>`;
  else if (m.error) body.textContent = m.error;
  if (m.status === 'streaming') (body.lastElementChild ?? body).classList.add('caret');
  if (m.from === 'user') el.querySelector('.bubble').insertAdjacentHTML('beforeend', deliveryHtml(m));
  if (['summary', 'review', 'final'].includes(m.kind) && m.status === 'complete') {
    const bubble = el.querySelector('.bubble');
    bubble.insertAdjacentHTML('beforeend', `<button class="btn copy-btn" data-copy="${m.id}" title="有定稿时复制定稿，否则复制总结和复核更正，可以粘贴到 Claude 或 Codex 桌面端继续推进">复制讨论结论</button>`);
    // 已结束、复核有内容、还没有定稿：可以补一份定稿
    const hasFinal = [...current.msgs.values()].some((x) => x.kind === 'final' && x.status === 'complete');
    if (m.kind === 'review' && !hasFinal && current.state?.phase === 'done') {
      bubble.insertAdjacentHTML('beforeend', ` <button class="btn copy-btn" data-finalize title="让一方把复核里的更正合并进总结（多一次模型调用，由额度更宽裕的一方来写）">合并成定稿</button>`);
    }
    if (m.kind === 'summary') $('#jumpSummaryBtn').classList.remove('hidden');
  }

  if (m.activity?.length) {
    const acts = document.createElement('details');
    acts.className = 'acts';
    acts.open = m.status === 'streaming';
    const shown = m.activity.slice(-30);
    acts.innerHTML = `<summary>${m.status === 'streaming' ? '正在查看资料' : '查看了资料'}（${m.activity.length} 步）</summary>` +
      shown.map((a) => `<div class="act">› ${esc(a)}</div>`).join('');
    el.querySelector('.bubble').appendChild(acts);
  }
}

function nearBottom() {
  const t = $('#timeline');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function scrollToBottom() {
  const t = $('#timeline');
  t.scrollTop = t.scrollHeight;
}

// ---------- 简易 Markdown ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    let h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) { out.push(`<h${Math.min(h[1].length + 2, 6)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 6)}>`); i++; continue; }
    if (/^【状态】/.test(line.trim())) { out.push(`<p class="status-line">${esc(line.trim())}</p>`); i++; continue; }
    if (/^【问用户】/.test(line.trim())) { out.push(`<p class="ask-user">${inline(line.trim())}</p>`); i++; continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ' ' + lines[i++].trim();
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const isSep = (r) => /^\|[\s:|-]+\|$/.test(r.trim());
      // 第二行是 |---|---| 分隔行时，第一行是表头
      const hasHead = rows.length > 1 && isSep(rows[1]);
      const head = hasHead ? `<thead><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` : '';
      const bodyRows = rows.slice(hasHead ? 2 : 0).filter((r) => !isSep(r));
      const tbody = `<tbody>${bodyRows.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="table-wrap"><table>${head}${tbody}</table></div>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(```|#{1,6}\s|>\s?|\s*([-*+]|\d+[.)])\s+|【状态】|【问用户】|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) { buf.push(lines[i++]); }
    out.push(`<p>${buf.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// ---------- 交互 ----------
async function send() {
  const input = $('#input');
  let text = input.value.trim();
  if (!text || !current) return;
  let t = target;
  // 直接在开头写 @Claude / @Codex 也能点名
  const m = text.match(/^@(claude|codex)\b[\s:：,，]*/i);
  if (m) { t = m[1].toLowerCase(); text = text.slice(m[0].length) || text; }
  const urgent = $('#urgentChk').checked;
  input.value = '';
  autosize();
  $('#urgentChk').checked = false;
  updateHint();
  try {
    await api(`/api/rooms/${current.id}/message`, { text, target: t, urgent });
  } catch (e) {
    input.value = text;
    alert(e.message);
  }
}

function action(name) {
  if (!current) return;
  api(`/api/rooms/${current.id}/${name}`, {}).catch((e) => alert(e.message));
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
}

async function openNewDialog() {
  $('#formError').textContent = '';
  const picker = document.querySelector('[data-picker="new"]');
  if (!picker.children.length) await renderPicker(picker);
  $('#newDialog').showModal();
  $('#newForm').topic.focus();
  loadProjects();
}

// ---------- 项目与已有对话 ----------
const OTHER = '__other__';
let pendingProject = null; // 从项目分组上的「＋」进来时预选该项目
async function loadProjects() {
  const sel = $('#projectSelect');
  const def = $('#cwdInput').dataset.default;
  // 默认选中：从分组「＋」进来的项目 > 上次选的 > 当前打开的讨论所在项目
  const keep = pendingProject ?? (sel.value || current?.state?.cwd || '');
  pendingProject = null;
  const projects = await api('/api/projects').catch(() => []);
  const label = (p) => {
    const tags = [];
    if (p.sources.includes('claude')) tags.push('Claude');
    if (p.sources.includes('codex')) tags.push('Codex');
    return `${p.path}${tags.length ? '（' + tags.join(' / ') + ' 用过）' : ''}`;
  };
  sel.innerHTML = projects.map((p) => `<option value="${esc(p.path)}">${esc(label(p))}</option>`).join('') +
    (def && !projects.some((p) => p.path.toLowerCase() === def.toLowerCase()) ? `<option value="${esc(def)}">${esc(def)}（讨论室自身）</option>` : '') +
    `<option value="${OTHER}">其他文件夹…</option>`;
  const match = keep && [...sel.options].find((o) => o.value.toLowerCase() === keep.toLowerCase());
  if (keep && !match && keep !== OTHER) {
    sel.insertAdjacentHTML('afterbegin', `<option value="${esc(keep)}">${esc(keep)}</option>`);
    sel.value = keep;
  } else {
    sel.value = match ? match.value : (sel.options[0]?.value ?? OTHER);
  }
  onProjectChange();
}

let sessionsReq = 0;
async function onProjectChange() {
  const v = $('#projectSelect').value;
  $('#cwdLabel').classList.toggle('hidden', v !== OTHER);
  const p = v === OTHER ? $('#cwdInput').value.trim() : v;
  const fc = $('#forkClaude');
  const fx = $('#forkCodex');
  const none = '<option value="">不带入，新开对话</option>';
  fc.innerHTML = none; fx.innerHTML = none;
  $('#ctxLine').innerHTML = '';
  if (!p) return;
  const my = ++sessionsReq;
  fc.innerHTML = fx.innerHTML = '<option value="">读取中…</option>';
  let r;
  try { r = await api(`/api/projects/sessions?path=${encodeURIComponent(p)}`); } catch (e) {
    if (my === sessionsReq) { fc.innerHTML = none; fx.innerHTML = none; $('#ctxLine').textContent = e.message; }
    return;
  }
  if (my !== sessionsReq) return;
  const opt = (s) => `<option value="${esc(s.id)}">${esc(s.title)} · ${new Date(s.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</option>`;
  fc.innerHTML = none + r.claude.map(opt).join('');
  fx.innerHTML = none + r.codex.map(opt).join('');
  const c = r.context;
  const chip = (on, text) => `<span class="chip ${on ? 'on' : ''}">${on ? '✓' : '–'} ${text}</span>`;
  $('#ctxLine').innerHTML = '自动带入：' +
    chip(c.claudeMd, 'CLAUDE.md') + chip(c.claudeMemories > 0, `Claude 记忆${c.claudeMemories ? ' ' + c.claudeMemories + ' 条' : ''}`) +
    chip(c.agentsMd, 'AGENTS.md') + chip(true, 'Codex 记忆');
}
$('#projectSelect').addEventListener('change', onProjectChange);
$('#cwdInput').addEventListener('change', onProjectChange);

async function openModelsDialog() {
  if (!current?.state) return;
  await renderPicker(document.querySelector('[data-picker="room"]'), current.state.models);
  $('#modelsDialog').showModal();
}
$('#chipClaude').onclick = openModelsDialog;
$('#chipCodex').onclick = openModelsDialog;
$('#cancelModels').onclick = () => $('#modelsDialog').close();
$('#modelsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = readPicker(document.querySelector('[data-picker="room"]'));
  $('#modelsDialog').close();
  api(`/api/rooms/${current.id}/models`, body).catch((err) => alert(err.message));
});

$('#newRoomBtn').onclick = openNewDialog;
$('#emptyNewBtn').onclick = openNewDialog;
$('#cancelNew').onclick = () => $('#newDialog').close();
$('#fillExample').onclick = () => {
  const f = $('#newForm');
  f.topic.value = '为这个讨论室设计插话、暂停和恢复机制。';
  f.background.value = '双方先独立提出方案，再交换意见。我会中途修改一项要求，最后叫停。讨论室的代码就在当前项目文件夹里，可以先读 lib/room.js 了解现状。';
};
$('#newForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const proj = $('#projectSelect').value;
  const body = {
    topic: f.topic.value,
    background: f.background.value,
    cwd: (proj && proj !== OTHER ? proj : f.cwd.value.trim()) || f.cwd.dataset.default,
    forkFrom: { claude: $('#forkClaude').value || null, codex: $('#forkCodex').value || null },
    maxRounds: f.maxRounds.value,
    firstSpeaker: f.firstSpeaker.value,
    mode: f.mode.value,
    maxTurns: f.maxTurns.value,
    models: readPicker(document.querySelector('[data-picker="new"]')),
  };
  $('#createBtn').disabled = true;
  try {
    const { id } = await api('/api/rooms', body);
    $('#newDialog').close();
    f.reset();
    openRoom(id);
  } catch (err) {
    $('#formError').textContent = err.message;
  } finally {
    $('#createBtn').disabled = false;
  }
});

$('#sendBtn').onclick = send;
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#input').addEventListener('input', autosize);
$('#urgentChk').addEventListener('change', updateHint);
$('#targetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  target = b.dataset.target;
  for (const x of $('#targetSeg').children) x.classList.toggle('on', x === b);
  updateHint();
});
$('#pauseBtn').onclick = () => action('pause');
$('#resumeBtn').onclick = () => action('resume');
$('#interruptBtn').onclick = () => action('interrupt');
$('#addRoundBtn').onclick = () => action('add-round');
$('#finishBtn').onclick = () => action('finish');
$('#stopBtn').onclick = () => { if (confirm('立即停止讨论，不做总结？')) action('stop'); };

// 「⋯」更多菜单：点外面或按 Esc 关闭，选完一项也关闭
function toggleMore(open) {
  const on = open ?? $('#moreMenu').classList.contains('hidden');
  $('#moreMenu').classList.toggle('hidden', !on);
  $('#moreBtn').setAttribute('aria-expanded', String(on));
}
$('#moreBtn').onclick = (e) => { e.stopPropagation(); toggleMore(); };
$('#moreMenu').addEventListener('click', () => toggleMore(false));
document.addEventListener('click', (e) => { if (!e.target.closest('.more')) toggleMore(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleMore(false); });
function toggleSidebar(open) {
  const on = open ?? !$('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', on);
  $('#scrim').classList.toggle('on', on);
}
$('#menuBtn').onclick = () => toggleSidebar();
$('#menuBtn2').onclick = () => toggleSidebar();
$('#scrim').onclick = () => toggleSidebar(false);
$('#jumpSummaryBtn').onclick = () => {
  const el = [...document.querySelectorAll('.msg[data-kind="final"]')].pop() ?? [...document.querySelectorAll('.msg[data-kind="summary"]')].pop();
  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
// 讨论结论 = 总结 + 紧随其后的复核（更正或补充）。只复制总结会把复核里指出的错误继续传下去
function conclusionText(clickedId) {
  const msgs = [...current.msgs.values()];
  const idx = msgs.findIndex((x) => x.id === clickedId);
  const summaryIdx = msgs[idx]?.kind === 'summary' ? idx : msgs.slice(0, idx + 1).map((x) => x.kind).lastIndexOf('summary');
  const summary = msgs[summaryIdx];
  if (!summary) return null;
  const review = msgs.slice(summaryIdx + 1).find((x) => x.kind === 'review' && x.status === 'complete');
  const final = msgs.slice(summaryIdx + 1).find((x) => x.kind === 'final' && x.status === 'complete');
  const name = (a) => NAMES[a] === '你' ? '用户' : NAMES[a];
  const s = current.state;
  // 有定稿就直接用定稿
  if (final) {
    return [`# 讨论结论：${s.topic}`, '',
      `> 来自 Claude × Codex 圆桌讨论（项目：${s.cwd}）。${name(summary.from)} 写总结，${review ? name(review.from) + ' 复核，' : ''}${name(final.from)} 已把复核更正合并进本定稿。`, '',
      final.text.trim(), ''].join('\n');
  }
  const parts = [`# 讨论结论：${s.topic}`, '', `> 来自 Claude × Codex 圆桌讨论（项目：${s.cwd}）。下面是 ${name(summary.from)} 写的总结和 ${review ? name(review.from) : '另一方'} 的复核；两者不一致时，以复核的更正为准。`, ''];
  // 原文里的标题降一级，嵌在「总结」「复核」之下
  const nest = (t) => t.trim().replace(/^(#{1,5})(\s)/gm, '#$1$2');
  parts.push(`## 总结（${name(summary.from)} 撰写）`, '', nest(summary.text), '');
  if (review) parts.push(`## 复核（${name(review.from)} 的更正与补充）`, '', nest(review.text), '');
  else parts.push('## 复核', '', '（复核尚未完成）', '');
  return parts.join('\n');
}

$('#timeline').addEventListener('click', async (e) => {
  if (e.target.closest('[data-finalize]') && current) {
    e.target.closest('[data-finalize]').remove();
    api(`/api/rooms/${current.id}/finalize`, {}).catch((err) => alert(err.message));
    return;
  }
  const b = e.target.closest('[data-copy]');
  if (!b || !current) return;
  const text = conclusionText(b.dataset.copy);
  if (!text) return;
  try { await navigator.clipboard.writeText(text); b.textContent = '✓ 已复制总结和复核，可粘贴到桌面端'; } catch { b.textContent = '复制失败'; }
  setTimeout(() => { b.textContent = '复制讨论结论'; }, 2500);
});

(async () => {
  loadHealth();
  loadStatus();
  loadModels();
  setInterval(loadStatus, 60000);
  setInterval(() => { if (current?.state) setState(current.state); }, 30000); // 刷新"本场时长"
  const rooms = await loadRooms();
  let last = null;
  try { last = localStorage.getItem('roundtable:last'); } catch {}
  if (last && rooms.some((r) => r.id === last)) openRoom(last);
  setInterval(loadRooms, 15000);
})();
