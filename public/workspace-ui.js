'use strict';

export function initWorkspace({ api, getCurrent, md }) {
  const byId = (id) => document.getElementById(id);
  const discussionTab = byId('discussionTab');
  const resultTab = byId('resultTab');
  const timeline = byId('timeline');
  const resultView = byId('resultView');
  const content = byId('resultContent');
  const status = byId('resultStatus');
  const copyBrief = byId('resultCopyBrief');
  const copyFull = byId('resultCopyFull');
  const toolsDialog = byId('roomToolsDialog');
  const steps = [...byId('workflowSteps').querySelectorAll('[data-step]')];
  let roomId = null;
  let view = 'discussion';
  let revision = 0;
  let signature = '';
  let result = null;
  let resultSignature = '';

  function hide(element, hidden) {
    element.hidden = hidden;
    element.classList.toggle('hidden', hidden);
  }

  function stateSignature(room) {
    const state = room?.state;
    if (!state) return '';
    // 只跟踪会改变结论可交付性的消息，流式增量不触发重复读取。
    const messages = [...(room.msgs?.values() ?? [])]
      .filter((message) => ['summary', 'review', 'final'].includes(message.kind)
        || message.from === 'evidence'
        || (['claude', 'codex'].includes(message.from) && ['independent', 'discussion'].includes(message.phase)))
      .map((message) => [message.id, message.kind, message.status, message.status === 'complete' ? message.text : '']);
    return JSON.stringify([state.phase, state.status, state.speaking, state.notice, messages]);
  }

  function renderSteps() {
    const phase = getCurrent()?.state?.phase;
    const current = phase === 'independent' ? 0 : phase === 'discussion' ? 1 : phase ? 2 : -1;
    const order = ['independent', 'discussion', 'result'];
    for (const step of steps) {
      const index = order.indexOf(step.dataset.step);
      step.dataset.state = index < current ? 'complete' : index === current ? 'current' : 'upcoming';
      if (index === current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
  }

  function selectView(next) {
    view = next;
    const discussion = next === 'discussion';
    hide(timeline, !discussion);
    hide(resultView, discussion);
    hide(document.querySelector('.composer'), !discussion);
    for (const [tab, selected] of [[discussionTab, discussion], [resultTab, !discussion]]) {
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('on', selected);
    }
  }

  function clearCopy() {
    hide(copyBrief, true);
    hide(copyFull, true);
    copyBrief.disabled = copyFull.disabled = true;
  }

  function renderEmpty(title, explanation, state = 'pending') {
    clearCopy();
    status.textContent = title;
    status.dataset.state = state;
    const empty = document.createElement('div');
    empty.className = 'result-empty';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const text = document.createElement('p');
    text.textContent = explanation;
    empty.append(heading, text);
    content.replaceChildren(empty);
    return empty;
  }

  function renderResult() {
    if (!result?.ready) {
      renderEmpty('结论尚未完成复核或更正', result?.notice || '回到讨论继续推进。完成复核后，最新结论会出现在这里。');
      return;
    }
    status.textContent = '最新结论 · 已完成复核';
    status.dataset.state = 'ready';
    content.replaceChildren();
    const addSection = (title, text, className) => {
      const section = document.createElement('section');
      section.className = `result-section ${className}`;
      const heading = document.createElement('h3');
      heading.textContent = title;
      const body = document.createElement('div');
      body.className = 'result-body';
      body.innerHTML = md(text);
      section.append(heading, body);
      content.appendChild(section);
    };
    if (result.brief) addSection('三句话版', result.brief, 'result-brief');
    else {
      const note = document.createElement('p');
      note.className = 'result-legacy-note';
      note.textContent = '这份记录没有三句话版，下面保留完整结论。';
      content.appendChild(note);
    }
    const full = result.full || result.text || '';
    if (full) addSection('完整结论', full, 'result-full');
    if (result.review) {
      const review = document.createElement('details');
      review.className = 'result-review';
      const summary = document.createElement('summary');
      summary.textContent = '复核意见';
      const body = document.createElement('div');
      body.innerHTML = md(result.review);
      review.append(summary, body);
      content.appendChild(review);
    }
    hide(copyBrief, !result.brief);
    hide(copyFull, !full);
    copyBrief.disabled = !result.brief;
    copyFull.disabled = !full;
  }

  async function refreshResult() {
    const room = getCurrent();
    if (!room?.id || !room.state) {
      renderEmpty('正在读取讨论状态', '讨论加载后即可查看最新结论。', 'loading');
      return;
    }
    const id = room.id;
    const requestedSignature = stateSignature(room);
    const token = ++revision;
    signature = requestedSignature;
    result = null;
    resultSignature = '';
    renderEmpty('正在读取最新结论', '正在确认总结与复核的完成状态。', 'loading');
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(id)}/result`);
      if (token !== revision || getCurrent()?.id !== id || stateSignature(getCurrent()) !== requestedSignature) return;
      result = data;
      resultSignature = requestedSignature;
      renderResult();
    } catch (error) {
      if (token !== revision || getCurrent()?.id !== id) return;
      const empty = renderEmpty('暂时无法读取结论', error.message || '请稍后重试。', 'error');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = '重新读取';
      retry.onclick = refreshResult;
      empty.appendChild(retry);
    }
  }

  function showDiscussion() {
    selectView('discussion');
  }

  function showResult() {
    const changed = view !== 'result';
    selectView('result');
    if (changed || signature !== stateSignature(getCurrent())) refreshResult();
  }

  function mountClaims() {
    const board = byId('claimBoard');
    const host = byId('claimBoardHost');
    if (board && host && board.parentElement !== host) host.appendChild(board);
    return board;
  }

  function reset() {
    revision++;
    roomId = getCurrent()?.id ?? null;
    signature = '';
    result = null;
    resultSignature = '';
    if (toolsDialog.open) toolsDialog.close();
    showDiscussion();
    renderEmpty('结论尚未完成复核或更正', '双方完成讨论与复核后，可在这里查看并复制结论。');
    renderSteps();
  }

  function sync() {
    if (getCurrent()?.id !== roomId) reset();
    renderSteps();
    mountClaims();
    const next = stateSignature(getCurrent());
    if (next === signature) return;
    signature = next;
    // 状态变化立即废弃旧结果，避免异步回包恢复过时的复制入口。
    revision++;
    result = null;
    resultSignature = '';
    clearCopy();
    if (view === 'result') refreshResult();
  }

  async function copy(kind) {
    if (!result?.ready || resultSignature !== stateSignature(getCurrent())) {
      sync();
      return;
    }
    const full = result.full || result.text;
    const text = kind === 'brief' ? result.brief : full && [
      `# 讨论结论：${getCurrent().state.topic}`, '', full,
      ...(result.review ? ['', '## 复核意见', '', result.review] : []),
    ].join('\n');
    if (!text) return;
    const id = roomId;
    const token = revision;
    try {
      await navigator.clipboard.writeText(text);
      if (id === roomId && token === revision) status.textContent = kind === 'brief' ? '已复制三句话版' : '已复制完整结论';
    } catch {
      if (id === roomId && token === revision) status.textContent = '复制失败，请重试或选中文本复制。';
    }
  }

  discussionTab.onclick = showDiscussion;
  resultTab.onclick = showResult;
  byId('resultBackBtn').onclick = () => { showDiscussion(); discussionTab.focus(); };
  copyBrief.onclick = () => copy('brief');
  copyFull.onclick = () => copy('full');
  for (const tab of [discussionTab, resultTab]) {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? discussionTab : event.key === 'End' ? resultTab : tab === discussionTab ? resultTab : discussionTab;
      next.focus();
      next.click();
    });
  }
  byId('roomToolsBtn').onclick = () => { mountClaims(); toolsDialog.showModal(); };
  byId('closeRoomTools').onclick = () => toolsDialog.close();
  byId('openClaimsBtn').onclick = () => {
    const board = mountClaims();
    if (!toolsDialog.open) toolsDialog.showModal();
    if (board) {
      board.open = true;
      board.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      board.querySelector('summary')?.focus({ preventScroll: true });
    }
  };

  reset();
  return { reset, sync, showDiscussion };
}
