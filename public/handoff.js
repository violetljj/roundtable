'use strict';

const LABELS = { draft: '待确认任务卡', running: '正在执行', reviewing: '另一方正在审查', ready: '等待你确认合并', failed: '执行未完成', cancelled: '已取消', merged: '已合并', discarded: '已放弃' };
const FIELDS = [
  ['goal', '目标', '这次要完成什么？'],
  ['plan', '采用方案', '确认要执行的方案和步骤'],
  ['constraints', '约束', '必须遵守的范围、预算和不可变条件'],
  ['disagreements', '未解决分歧', '保留尚未达成一致的事项；没有则写“无”'],
  ['files', '相关文件', '预计涉及的文件或目录'],
  ['acceptance', '验收标准', '完成后应满足什么条件，如何验证？'],
];

export function initHandoff({ api, getCurrent }) {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/handoff.css';
  document.head.appendChild(css);
  const button = document.createElement('button');
  button.id = 'handoffBtn';
  button.className = 'btn accent hidden';
  button.textContent = '交给 AI 执行';
  document.getElementById('jumpSummaryBtn').after(button);
  const dialog = document.createElement('dialog');
  dialog.id = 'handoffDialog';
  dialog.setAttribute('aria-labelledby', 'handoffTitle');
  dialog.innerHTML = `
    <div class="hf-head"><div><div class="hf-eyebrow">讨论 → 执行 → 审查 → 合并</div><h3 id="handoffTitle">执行交接</h3></div><button type="button" class="icon-btn" data-close aria-label="关闭执行交接">×</button></div>
    <div class="hf-body">
      <p class="hf-topic"></p>
      <div class="hf-status" role="status" aria-live="polite"></div>
      <p class="hf-note">确认任务卡后，一方在独立工作区执行，另一方审查改动。你查看结果后决定是否合并。账号与额度可在左侧查看。</p>
      <p class="hf-error" role="alert" hidden></p>
      <form class="hf-form">
        <div class="hf-fields"></div>
        <div class="hf-options"><label>执行方<select name="executor"><option value="codex">Codex 执行 · Claude 审查</option><option value="claude">Claude 执行 · Codex 审查</option></select></label><label>最长执行时间（分钟）<input name="timeoutMinutes" type="number" min="1" max="60" value="15" required></label></div>
        <p class="hf-note" data-executor-note></p>
        <div class="hf-actions" data-draft><button class="btn" type="button" data-save>保存任务卡</button><button class="btn" type="button" data-regenerate>从最新结论重新生成</button><button class="btn primary" type="submit">确认并开始执行</button><span class="hf-save-status" role="status"></span></div>
      </form>
      <div class="hf-actions" data-active hidden><button class="btn warn" type="button" data-cancel>取消本次执行</button><span class="hf-note">关闭面板后仍会继续；完成时顶部入口会更新。</span></div>
      <section class="hf-result" hidden>
        <dl class="hf-meta"></dl>
        <details data-result="diff" open><summary>代码改动</summary><pre></pre></details>
        <details data-result="execution"><summary>执行记录</summary><pre></pre></details>
        <details data-result="review" open><summary>另一方的审查</summary><pre></pre></details>
        <details data-result="logs"><summary>过程日志</summary><pre></pre></details>
      </section>
      <div class="hf-actions" data-ready hidden><button class="btn primary" type="button" data-merge>确认合并到原分支</button></div>
      <div class="hf-merge-confirm" hidden><p>将合并下面这份已审查的提交：</p><code></code><p>请先阅读上面的代码改动和审查意见。</p><button class="btn primary" type="button" data-confirm-merge>确认合并此提交</button><button class="btn" type="button" data-abort-merge>返回查看</button></div>
      <div class="hf-actions" data-finished hidden><button class="btn warn" type="button" data-discard>放弃改动并清理工作区</button><span class="hf-note">保留任务卡、执行和审查记录。</span></div>
    </div>`;
  document.body.appendChild(dialog);
  const q = (selector) => dialog.querySelector(selector);
  const form = q('form');
  for (const [key, label, placeholder] of FIELDS) {
    const item = document.createElement('label');
    item.textContent = label;
    const input = document.createElement('textarea');
    input.name = key;
    input.rows = key === 'plan' ? 5 : 3;
    input.placeholder = placeholder;
    input.required = ['goal', 'plan', 'acceptance'].includes(key);
    item.appendChild(input);
    q('.hf-fields').appendChild(item);
  }
  let roomId = null;
  let state = null;
  let loading = false;
  let busy = false;
  let dirty = false;
  let generation = 0;
  let version = 0;
  let loaded = false;
  let mergeCommit = null;
  const unwrap = (value) => value?.handoff ?? value;
  const serialize = (value) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  const setError = (message = '') => { q('.hf-error').textContent = message; q('.hf-error').hidden = !message; };
  function resetMerge() { mergeCommit = null; q('.hf-merge-confirm').hidden = true; }
  function fillCard() {
    for (const [key] of FIELDS) form.elements[key].value = state?.card?.[key] ?? '';
    form.elements.executor.value = state?.executor ?? 'codex';
    form.elements.timeoutMinutes.value = state?.timeoutMinutes ?? 15;
    dirty = false;
  }
  function executorNote() {
    q('[data-executor-note]').textContent = form.elements.executor.value === 'claude'
      ? 'Claude 生成文件变更，由讨论室限制在工作区内写入；不开放命令执行，不能自行运行测试。'
      : 'Codex 在独立工作区的写入沙盒内执行，可运行验收测试。';
  }
  function render() {
    const room = getCurrent();
    if (room?.id !== roomId) return;
    button.classList.toggle('hidden', room?.state?.phase !== 'done' && !state);
    button.textContent = state && state.status !== 'draft' ? `执行交接 · ${LABELS[state.status] ?? state.status}` : '交给 AI 执行';
    button.dataset.status = state?.status ?? '';
    q('.hf-topic').textContent = room.state?.topic ?? '';
    q('.hf-status').textContent = loading ? '正在读取任务卡…' : LABELS[state?.status] ?? '还没有可交接的完整讨论结论';
    q('.hf-status').dataset.status = state?.status ?? '';
    const draft = state?.status === 'draft';
    const active = ['running', 'reviewing'].includes(state?.status);
    form.hidden = !state;
    for (const input of form.querySelectorAll('input, select, textarea')) input.disabled = !draft || busy;
    q('[data-draft]').hidden = !draft;
    q('[data-active]').hidden = !active;
    q('[data-ready]').hidden = state?.status !== 'ready' || !state?.commit;
    q('[data-finished]').hidden = !['ready', 'failed', 'cancelled'].includes(state?.status);
    q('.hf-save-status').textContent = dirty ? '尚未保存' : '';
    executorNote();
    q('.hf-result').hidden = !state || state.status === 'draft';
    const meta = q('.hf-meta');
    meta.replaceChildren();
    for (const [label, value] of [['工作区', state?.worktree], ['执行分支', state?.branch], ['合并目标', state?.baseBranch], ['提交', state?.commit]]) {
      if (!value) continue;
      const term = document.createElement('dt'); term.textContent = label;
      const desc = document.createElement('dd'); desc.textContent = value;
      meta.append(term, desc);
    }
    for (const key of ['diff', 'execution', 'review', 'logs']) {
      const details = q(`[data-result="${key}"]`);
      const text = serialize(state?.[key]);
      details.hidden = !text || text === '[]';
      details.querySelector('pre').textContent = text;
    }
    for (const action of dialog.querySelectorAll('button:not([data-close])')) action.disabled = busy || loading;
    if (mergeCommit && (state?.status !== 'ready' || state?.commit !== mergeCommit)) resetMerge();
  }
  async function refresh() {
    if (!roomId || loading) return;
    const id = roomId;
    const token = generation;
    const oldVersion = version;
    loading = true;
    loaded = true;
    render();
    try {
      const data = unwrap(await api(`/api/rooms/${encodeURIComponent(id)}/handoff`));
      if (token !== generation || getCurrent()?.id !== id || oldVersion !== version) return;
      state = data;
      if (!dirty) fillCard();
      setError(state?.error ?? '');
    } catch (err) { if (token === generation && getCurrent()?.id === id) setError(err.message); }
    finally { if (token === generation) { loading = false; render(); } }
  }
  function sync(room) {
    if (room?.id !== roomId) {
      roomId = room?.id ?? null;
      generation++;
      version = 0;
      state = null;
      loaded = false;
      loading = busy = dirty = false;
      resetMerge();
      setError();
      dialog.close();
      q('.hf-body').scrollTop = 0;
    }
    render();
    if (room?.state?.phase === 'done' && !loaded) refresh();
  }
  function update(id, data) {
    if (id !== roomId || getCurrent()?.id !== id) return;
    version++;
    state = unwrap(data);
    if (!dirty || state?.status !== 'draft') fillCard();
    setError(state?.error ?? '');
    render();
  }
  function readCard() { return Object.fromEntries(FIELDS.map(([key]) => [key, form.elements[key].value.trim()])); }
  async function action(name, body = {}) {
    if (busy || loading || !roomId) return;
    const id = roomId;
    const token = generation;
    const oldVersion = version;
    busy = true;
    setError();
    render();
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(id)}/handoff/${name}`, body);
      if (token !== generation || getCurrent()?.id !== id) return;
      dirty = false;
      if (oldVersion === version) update(id, data);
      else { fillCard(); render(); }
      if (name === 'merge') resetMerge();
    } catch (err) { if (token === generation && getCurrent()?.id === id) setError(err.message); }
    finally { if (token === generation) { busy = false; render(); } }
  }
  button.onclick = () => { sync(getCurrent()); dialog.showModal(); q('.hf-body').scrollTop = 0; refresh(); };
  q('[data-close]').onclick = () => dialog.close();
  form.addEventListener('input', () => { dirty = true; q('.hf-save-status').textContent = '尚未保存'; executorNote(); });
  q('[data-save]').onclick = () => action('card', { card: readCard(), executor: form.elements.executor.value, timeoutMinutes: Number(form.elements.timeoutMinutes.value) });
  q('[data-regenerate]').onclick = () => {
    if (confirm('根据最新讨论结论重新生成任务卡？这会覆盖当前任务卡的编辑。')) action('card', { regenerate: true });
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    action('start', { confirmed: true, card: readCard(), executor: form.elements.executor.value, timeoutMinutes: Number(form.elements.timeoutMinutes.value) });
  };
  q('[data-cancel]').onclick = () => action('cancel');
  q('[data-merge]').onclick = () => {
    mergeCommit = state.commit;
    q('.hf-merge-confirm code').textContent = `${state.baseBranch ?? '原分支'} ← ${mergeCommit}`;
    q('.hf-merge-confirm').hidden = false;
    q('[data-confirm-merge]').focus();
  };
  q('[data-abort-merge]').onclick = resetMerge;
  q('[data-confirm-merge]').onclick = () => { if (mergeCommit === state?.commit) action('merge', { confirmed: true, commit: mergeCommit }); };
  q('[data-discard]').onclick = () => {
    if (confirm('放弃本次改动并清理独立工作区？任务卡、执行和审查记录会保留。')) action('discard', { confirmed: true });
  };
  sync(getCurrent());
  return { sync, update, refresh };
}
