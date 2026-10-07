'use strict';

const LABELS = { draft: '待你批准', running: '实验进行中', completed: '报告已生成', failed: '实验未完成', cancelled: '已取消', returned: '已带回讨论' };
const FIELDS = [
  ['question', '要裁决的分歧', '双方对哪个可验证的事实有不同判断？'],
  ['decisionRule', '什么结果会改变结论', '先约定：出现什么结果支持哪一方；什么结果仍不足以下结论？'],
  ['procedure', '实验步骤与范围', '列出要运行的脚本或测试、输入、观察项和资源限制。'],
];
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'returned']);

export function initExperiments({ api, getCurrent, onState }) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/experiment-panel.css';
  document.head.appendChild(css);
  const button = document.createElement('button');
  button.id = 'experimentBtn';
  button.className = 'btn hidden';
  button.textContent = '小实验';
  document.getElementById('jumpSummaryBtn').after(button);
  const dialog = document.createElement('dialog');
  dialog.id = 'experimentDialog';
  dialog.setAttribute('aria-labelledby', 'experimentTitle');
  dialog.innerHTML = `
    <div class="xp-head"><div><div class="xp-eyebrow">分歧 → 约定判据 → 实验 → 重新判断</div><h3 id="experimentTitle">用小实验裁决</h3></div><button type="button" class="icon-btn" data-close aria-label="关闭小实验">×</button></div>
    <div class="xp-body">
      <p class="xp-topic"></p>
      <div class="xp-status" role="status" aria-live="polite"></div>
      <button type="button" class="link" data-current hidden>返回当前实验卡</button>
      <p class="xp-note">保存实验卡会暂停讨论，等待当前发言结束。你批准后，Codex 在独立工作区、禁网沙盒中运行实验；改动不会合并到原项目。</p>
      <p class="xp-note">起草和保存不调用模型；点击「批准这张实验卡并开始」才开始消耗模型额度。回传后双方重新讨论也会消耗额度。时限是最长运行时间，不是额度上限。</p>
      <details data-source hidden><summary>原发言摘录</summary><pre data-excerpt></pre></details>
      <p class="xp-error" role="alert" hidden></p>
      <form class="xp-form">
        <div class="xp-fields"></div>
        <label class="xp-budget">最长运行时间（分钟）<input name="budgetMinutes" type="number" min="1" max="30" value="3" required></label>
        <div class="xp-actions" data-edit><button type="submit" class="btn">保存实验卡并暂停</button><span class="xp-save-status" role="status"></span></div>
      </form>
      <div class="xp-approval" data-approval hidden><p class="xp-pause-note"></p><button type="button" class="btn primary" data-start>批准这张实验卡并开始</button></div>
      <div class="xp-actions" data-active hidden><button type="button" class="btn warn" data-cancel>取消实验</button><span class="xp-note">关闭面板不停止实验。</span></div>
      <section class="xp-result" hidden>
        <dl class="xp-meta"></dl>
        <details open><summary>实验报告</summary><pre data-report></pre></details>
        <p class="xp-note">报告是待双方评估的实验材料，可能包含模型解释；报告生成不代表判据已通过。失败、取消和未验证的边界也应保留。</p>
        <div class="xp-actions"><button type="button" class="btn primary" data-return>带回讨论并继续</button><button type="button" class="btn" data-new>申请另一个实验</button></div>
      </section>
      <details class="xp-history" hidden><summary>以前的实验</summary><div></div></details>
    </div>`;
  document.body.appendChild(dialog);
  const q = (selector) => dialog.querySelector(selector);
  const form = q('form');
  for (const [key, label, placeholder] of FIELDS) {
    const item = document.createElement('label');
    item.textContent = label;
    const input = document.createElement('textarea');
    input.name = key;
    input.rows = key === 'procedure' ? 4 : 3;
    input.required = true;
    input.maxLength = 12000;
    input.placeholder = placeholder;
    item.appendChild(input);
    q('.xp-fields').appendChild(item);
  }
  let roomId = null;
  let state = null;
  let loaded = false;
  let loading = false;
  let busy = false;
  let dirty = false;
  let creating = false;
  let generation = 0;
  let version = 0;
  let readPromise = null;
  let sourceMessageId = '';
  let sourceExcerpt = '';
  let viewingRecord = '';
  const unwrap = (value) => value && Object.hasOwn(value, 'experiment') ? value.experiment : value;
  const asText = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const setError = (message = '') => { q('.xp-error').textContent = message; q('.xp-error').hidden = !message; };
  function fillCard() {
    for (const [key] of FIELDS) form.elements[key].value = creating ? '' : state?.card?.[key] ?? '';
    form.elements.budgetMinutes.value = creating ? 3 : state?.budgetMinutes ?? 3;
    sourceMessageId = creating ? '' : state?.sourceMessageId ?? '';
    sourceExcerpt = creating ? '' : state?.sourceExcerpt ?? '';
    dirty = false;
  }
  function addMeta(meta, label, value) {
    if (!value) return;
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = String(value);
    meta.append(dt, dd);
  }
  function renderHistory() {
    const history = state?.history ?? [];
    const container = q('.xp-history div');
    const opened = new Set([...container.children].filter((el) => el.open).map((el) => el.dataset.experimentId));
    container.replaceChildren();
    q('.xp-history').hidden = !history.length;
    for (const record of [...history].reverse()) {
      const details = document.createElement('details');
      details.dataset.experimentId = record.id;
      details.open = opened.has(record.id);
      const summary = document.createElement('summary');
      summary.textContent = `${LABELS[record.status] ?? record.status} · ${record.card?.question ?? '实验'}`;
      const pre = document.createElement('pre');
      pre.textContent = [record.sourceExcerpt && `原发言摘录：\n${record.sourceExcerpt}`, asText(record.card), record.report, record.error, record.cleanupError, record.baseHead && `起始 HEAD：${record.baseHead}`, record.worktree && `工作区：${record.worktree}${record.worktreeRemoved ? '（已清理）' : '（保留）'}`].filter(Boolean).join('\n\n');
      details.append(summary, pre);
      container.appendChild(details);
    }
  }
  function render() {
    const room = getCurrent();
    if (room?.id !== roomId) return;
    button.classList.toggle('hidden', !roomId);
    button.textContent = state ? `小实验 · ${LABELS[state.status] ?? state.status}` : '小实验';
    button.dataset.status = state?.status ?? '';
    q('.xp-topic').textContent = room?.state?.topic ?? '';
    const historical = !!viewingRecord && viewingRecord !== state?.id;
    form.hidden = historical;
    q('[data-current]').hidden = !historical;
    q('[data-source]').hidden = historical || !sourceMessageId;
    q('[data-excerpt]').textContent = sourceExcerpt;
    q('.xp-status').textContent = loading ? '正在读取实验记录…' : creating ? '新实验草稿' : LABELS[state?.status] ?? '先写下分歧和判据';
    if (historical) q('.xp-status').textContent = '正在查看以前的实验；当前实验卡的操作已收起';
    q('.xp-status').dataset.status = state?.status ?? '';
    const editable = !state || state.status === 'draft' || creating;
    const allowedPhase = ['discussion', 'done'].includes(room?.state?.phase);
    const idle = room?.state?.status === 'paused' && !room?.state?.speaking?.length;
    const draft = state?.status === 'draft' && !creating;
    for (const input of form.querySelectorAll('textarea, input')) input.disabled = !editable || busy || loading;
    for (const action of dialog.querySelectorAll('button:not([data-close])')) action.disabled = busy || loading;
    q('[data-edit]').hidden = !editable;
    q('[data-edit] button').disabled = busy || loading || !allowedPhase;
    q('.xp-save-status').textContent = !allowedPhase ? '进入交叉讨论或讨论结束后可申请实验' : dirty ? '尚未保存；保存后才能批准' : '';
    q('[data-approval]').hidden = historical || !draft;
    q('.xp-pause-note').textContent = dirty ? '实验卡有未保存的修改，请先保存。' : !allowedPhase ? '当前阶段暂不能启动实验。' : idle ? '讨论已暂停。请核对上面的步骤、判据和时限，再批准执行。' : '实验卡已保存，等待讨论暂停且当前发言结束后可批准。';
    q('[data-start]').disabled = busy || loading || dirty || !idle || !allowedPhase;
    q('[data-active]').hidden = historical || state?.status !== 'running';
    q('.xp-result').hidden = historical || creating || !TERMINAL.has(state?.status);
    q('[data-return]').hidden = state?.status === 'returned';
    q('[data-new]').hidden = creating;
    const meta = q('.xp-meta');
    meta.replaceChildren();
    addMeta(meta, '起始 HEAD', state?.baseHead);
    addMeta(meta, '原项目', state?.repo);
    addMeta(meta, '实验工作区', state?.worktree);
    if (state?.worktree) addMeta(meta, '工作区状态', state.worktreeRemoved ? '已清理；报告保留' : '保留供检查');
    addMeta(meta, '清理情况', state?.cleanupError);
    addMeta(meta, '运行时限', state ? `${state.budgetMinutes} 分钟` : '');
    q('[data-report]').textContent = asText(state?.report) || state?.error || '没有完成的实验报告。';
    renderHistory();
  }
  function refresh() {
    if (!roomId) return Promise.resolve();
    if (loading) return readPromise;
    const id = roomId;
    const token = generation;
    const priorVersion = version;
    loading = true;
    render();
    readPromise = (async () => { try {
      const data = await api(`/api/rooms/${encodeURIComponent(id)}/experiment`);
      if (token !== generation || getCurrent()?.id !== id || priorVersion !== version) return;
      state = unwrap(data);
      onState?.(id, state);
      loaded = true;
      if (!dirty && !creating) fillCard();
      setError(state?.error ?? '');
    } catch (err) { if (token === generation && getCurrent()?.id === id) setError(err.message); }
    finally { if (token === generation) { loading = false; readPromise = null; render(); } }
    })();
    return readPromise;
  }
  function sync(room) {
    if (room?.id !== roomId) {
      roomId = room?.id ?? null;
      generation++;
      version = 0;
      state = null;
      viewingRecord = '';
      onState?.(roomId, null);
      loaded = loading = busy = dirty = creating = false;
      readPromise = null;
      setError();
      fillCard();
      dialog.close();
    }
    render();
    if (roomId && !loaded && !loading) refresh();
  }
  function update(id, data) {
    if (id !== roomId || getCurrent()?.id !== id) return;
    version++;
    loaded = true;
    state = unwrap(data);
    onState?.(id, state);
    if (!creating && (!dirty || state?.status !== 'draft')) fillCard();
    setError(state?.error ?? '');
    render();
  }
  async function action(name, body = {}) {
    if (busy || loading || !roomId) return;
    const id = roomId;
    const token = generation;
    const priorVersion = version;
    busy = true;
    setError();
    render();
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(id)}/experiment/${name}`, body);
      if (token !== generation || getCurrent()?.id !== id) return;
      dirty = false;
      creating = false;
      // SSE 可能先于 POST 返回，不能把更新的运行状态覆盖成草稿。
      if (priorVersion === version) update(id, data);
      else { fillCard(); render(); }
    } catch (err) { if (token === generation && getCurrent()?.id === id) setError(err.message); }
    finally { if (token === generation) { busy = false; render(); } }
  }
  button.onclick = () => { viewingRecord = ''; sync(getCurrent()); dialog.showModal(); refresh(); };
  q('[data-current]').onclick = () => { viewingRecord = ''; render(); };
  q('[data-close]').onclick = () => dialog.close();
  form.addEventListener('input', () => { dirty = true; render(); });
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const card = Object.fromEntries(FIELDS.map(([key]) => [key, form.elements[key].value.trim()]));
    action('card', { card, budgetMinutes: Number(form.elements.budgetMinutes.value), ...(sourceMessageId ? { sourceMessageId, sourceExcerpt } : {}), ...(creating ? { newExperiment: true } : {}) });
  };
  q('[data-start]').onclick = () => action('start', { confirmed: true });
  q('[data-cancel]').onclick = () => action('cancel');
  q('[data-return]').onclick = () => action('return', { confirmed: true });
  q('[data-new]').onclick = () => {
    creating = true;
    fillCard();
    setError();
    render();
    form.elements.question.focus();
  };
  sync(getCurrent());
  async function openDraft(seed) {
    viewingRecord = '';
    sync(getCurrent());
    document.getElementById('roomToolsDialog').close();
    dialog.showModal();
    const id = roomId;
    if (!loaded) await refresh();
    if (getCurrent()?.id !== id) return;
    if (!loaded) { setError('实验记录读取失败，请关闭面板后重试。'); return; }
    if (loading || busy) { setError('实验记录仍在读取或保存，请稍后再起草。'); return; }
    if (dirty) { setError('已有未保存的实验草稿，请先保存当前草稿，再从另一条发言起草。'); return; }
    if (state?.status === 'running') { setError('当前实验仍在运行，请先查看或取消。'); return; }
    creating = !!state && state.status !== 'draft';
    fillCard();
    for (const [key] of FIELDS) form.elements[key].value = seed.card?.[key] ?? '';
    sourceMessageId = seed.sourceMessageId;
    sourceExcerpt = seed.sourceExcerpt;
    dirty = true;
    setError(); render();
    form.elements.question.focus();
  }
  async function openRecord(recordId) {
    sync(getCurrent());
    document.getElementById('roomToolsDialog').close();
    dialog.showModal();
    const id = roomId;
    await refresh();
    if (getCurrent()?.id !== id) return;
    viewingRecord = recordId === state?.id ? '' : recordId;
    render();
    if (!viewingRecord) return;
    const record = [...q('.xp-history div').children].find((el) => el.dataset.experimentId === recordId);
    if (record) {
      q('.xp-history').open = true;
      record.open = true;
      record.scrollIntoView({ block: 'center' });
    }
  }
  return { sync, update, refresh, openDraft, openRecord };
}
