const DISCUSSION = { unresolved: '尚未判断', consensus: '双方共识', disputed: '存在分歧' };
const EVIDENCE = { unverified: '待核实', supported: '有支持', counter: '有反证' };
const NAMES = { claude: 'Claude', codex: 'Codex' };

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function initClaimBoard({ api, getCurrent, openSource }) {
  const css = node('link');
  css.rel = 'stylesheet';
  css.href = '/claim-board.css';
  document.head.appendChild(css);
  const board = node('details', 'claim-board');
  board.id = 'claimBoard';
  const summary = node('summary');
  const heading = node('span', '', '主张与核查');
  const count = node('span', 'claim-count');
  summary.append(heading, count);
  const list = node('div', 'claim-list');
  board.append(summary, list);
  document.getElementById('timeline').before(board);

  const dialog = node('dialog', 'claim-dialog');
  dialog.id = 'claimDialog';
  dialog.setAttribute('aria-labelledby', 'claimTitle');
  // 固定模板不含模型输出；发言与引用一律通过 textContent 填充。
  dialog.innerHTML = `<div class="claim-head"><h3 id="claimTitle">核查一条主张</h3><button type="button" class="icon-btn" data-close aria-label="关闭主张详情">×</button></div>
    <p class="claim-author"></p><p class="claim-text"></p>
    <button type="button" class="link" data-original>回到原发言</button>
    <h4>依据与出处</h4><p class="claim-hint">出处由发言方提供；“本场读取”是作者自述，不代表系统已核验。</p><ul class="claim-sources"></ul>
    <h4>怎样验证</h4><p class="claim-verification"></p>
    <form class="claim-form"><h4>你标记的状态</h4><p class="claim-hint">双方同意和证据充分是两件事；标记不会自动改变模型观点。</p>
      <div class="claim-selects"><label>双方态度<select name="discussion"></select></label><label>证据状态<select name="evidence"></select></label></div>
      <label>你的备注<textarea name="note" rows="3" maxlength="4000" placeholder="例如：需要查看最新文件；已用哪个结果验证……"></textarea></label>
      <div class="claim-actions"><button class="btn" type="submit" data-save>保存标记</button><button class="btn primary" type="button" data-check>请另一方核查</button></div>
      <p class="claim-check-hint claim-hint"></p><p class="claim-feedback" role="status" aria-live="polite"></p>
    </form>`;
  document.body.appendChild(dialog);
  const q = (s) => dialog.querySelector(s);
  for (const [name, options] of Object.entries({ discussion: DISCUSSION, evidence: EVIDENCE })) {
    for (const [value, text] of Object.entries(options)) {
      const option = node('option', '', text);
      option.value = value;
      q(`[name="${name}"]`).appendChild(option);
    }
  }

  let roomId = null;
  let selectedId = null;
  const drafts = new Map();
  const savedDrafts = new Map();
  const pending = new Set();
  const feedback = new Map();
  const key = (room, id) => JSON.stringify([room, id]);
  const selected = () => getCurrent()?.state?.claims?.find((c) => c.id === selectedId);
  const readForm = () => ({ discussion: q('[name="discussion"]').value, evidence: q('[name="evidence"]').value, note: q('[name="note"]').value });
  const checkHint = () => getCurrent()?.state?.phase === 'independent'
    ? '独立提案结束后才能转给另一方核查，避免提前泄露观点。'
    : '将发送一条定向用户消息，触发模型发言，并按当前阶段的发言上限计入预算。';
  const canCheck = () => !!getCurrent()?.state && getCurrent().state.phase !== 'independent';

  function goToMessage(messageId) {
    const el = document.getElementById('m-' + messageId);
    if (!el) return;
    if (dialog.open) dialog.close();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  }

  function renderDetail() {
    const claim = selected();
    if (!claim || getCurrent()?.id !== roomId) {
      if (dialog.open) dialog.close();
      return;
    }
    q('.claim-author').textContent = `${NAMES[claim.from] || claim.from} 提出的主张`;
    q('.claim-text').textContent = claim.text;
    q('.claim-verification').textContent = claim.verification || '尚未给出验证方法，可请另一方补充。';
    const sources = q('.claim-sources');
    sources.replaceChildren();
    for (const source of claim.sources || []) {
      const item = node('li');
      if (openSource) {
        const button = node('button', 'link claim-source-link', source);
        button.type = 'button';
        button.onclick = () => openSource(source);
        item.appendChild(button);
      } else item.textContent = source;
      sources.appendChild(item);
    }
    if (!sources.childElementCount) sources.appendChild(node('li', 'claim-hint', '未注明出处；请结合原发言区分事实、推测和建议。'));
    const values = drafts.get(key(roomId, claim.id)) || claim;
    for (const name of ['discussion', 'evidence', 'note']) {
      const input = q(`[name="${name}"]`);
      const value = values[name] || ({ discussion: 'unresolved', evidence: 'unverified', note: '' })[name];
      // 同房间的状态推送不重置光标或尚未保存的编辑。
      if (input.value !== value) input.value = value;
    }
    q('[data-save]').disabled = pending.has(key(roomId, 'save:' + claim.id));
    q('[data-check]').disabled = !canCheck() || pending.has(key(roomId, 'check:' + claim.messageId));
    q('.claim-check-hint').textContent = checkHint();
    q('.claim-feedback').textContent = feedback.get(key(roomId, claim.id)) || '';
  }

  function refreshButtons() {
    for (const el of document.querySelectorAll('.claim-message-actions')) {
      const id = el.dataset.messageId;
      const busy = pending.has(key(roomId, 'check:' + id));
      const button = el.querySelector('button');
      button.disabled = !canCheck() || busy;
      button.textContent = busy ? '正在发送…' : '请另一方核查';
      button.title = checkHint();
      el.querySelector('span').textContent = feedback.get(key(roomId, 'message:' + id)) || (canCheck() ? '' : '独立提案结束后可核查');
    }
  }

  function sync(current) {
    if (current?.id !== roomId) {
      roomId = current?.id || null;
      selectedId = null;
      board.open = false;
      if (dialog.open) dialog.close();
    }
    const claims = current?.state?.claims || [];
    for (const claim of claims) {
      const draftKey = key(roomId, claim.id);
      const saved = savedDrafts.get(draftKey);
      if (saved && ['discussion', 'evidence', 'note'].every((name) => (claim[name] || '') === saved[name])) {
        if (JSON.stringify(drafts.get(draftKey)) === JSON.stringify(saved)) drafts.delete(draftKey);
        savedDrafts.delete(draftKey);
      }
    }
    count.textContent = `${claims.length} 条 · ${claims.filter((c) => c.discussion === 'disputed').length} 条分歧 · ${claims.filter((c) => c.evidence === 'unverified').length} 条待核实`;
    list.replaceChildren();
    if (!claims.length) {
      list.appendChild(node('p', 'claim-hint', '发言中的【主张】会汇集到这里。也可在任意完整发言下请另一方核查。'));
    }
    for (const claim of claims) {
      const button = node('button', 'claim-row');
      button.type = 'button';
      button.append(node('span', 'claim-row-text', claim.text), node('span', 'claim-row-meta', `${NAMES[claim.from] || claim.from} · ${DISCUSSION[claim.discussion] || DISCUSSION.unresolved} · ${EVIDENCE[claim.evidence] || EVIDENCE.unverified}`));
      button.onclick = () => {
        selectedId = claim.id;
        renderDetail();
        dialog.showModal();
      };
      list.appendChild(button);
    }
    if (dialog.open) renderDetail();
    refreshButtons();
  }

  async function requestCheck(messageId, claimId) {
    const current = getCurrent();
    if (!current || !canCheck()) return;
    const requestedRoom = current.id;
    const operationKey = key(requestedRoom, 'check:' + messageId);
    if (pending.has(operationKey)) return;
    const feedbackKey = key(requestedRoom, claimId || 'message:' + messageId);
    pending.add(operationKey);
    feedback.set(feedbackKey, '正在发送核查请求…');
    renderDetail();
    refreshButtons();
    try {
      await api(`/api/rooms/${encodeURIComponent(requestedRoom)}/check`, { messageId, ...(claimId ? { claimId } : {}) });
      feedback.set(feedbackKey, '已发送核查请求，请在讨论中查看回应。');
    } catch (error) {
      feedback.set(feedbackKey, error.message || '核查请求未发送，请重试。');
    } finally {
      pending.delete(operationKey);
      if (getCurrent()?.id === requestedRoom) {
        renderDetail();
        refreshButtons();
      }
    }
  }

  function decorateMessage(message, element) {
    if (!['claude', 'codex'].includes(message.from) || message.status !== 'complete') return;
    const bubble = element.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.claim-message-actions')) return;
    const actions = node('div', 'claim-message-actions');
    actions.dataset.messageId = message.id;
    const button = node('button', 'btn', '请另一方核查');
    button.type = 'button';
    const renderedRoom = getCurrent()?.id;
    button.onclick = () => {
      if (getCurrent()?.id === renderedRoom) requestCheck(message.id);
    };
    const status = node('span', 'claim-hint');
    status.setAttribute('role', 'status');
    actions.append(button, status);
    bubble.appendChild(actions);
    refreshButtons();
  }

  q('[data-close]').onclick = () => dialog.close();
  q('[data-original]').onclick = () => { const claim = selected(); if (claim) goToMessage(claim.messageId); };
  q('[data-check]').onclick = () => { const claim = selected(); if (claim) requestCheck(claim.messageId, claim.id); };
  q('form').oninput = () => {
    if (selectedId && roomId) drafts.set(key(roomId, selectedId), readForm());
  };
  q('form').onsubmit = async (event) => {
    event.preventDefault();
    const claim = selected();
    const requestedRoom = roomId;
    if (!claim || getCurrent()?.id !== requestedRoom) return;
    const draftKey = key(requestedRoom, claim.id);
    const operationKey = key(requestedRoom, 'save:' + claim.id);
    if (pending.has(operationKey)) return;
    const values = readForm();
    values.note = values.note.trim();
    drafts.set(draftKey, values);
    pending.add(operationKey);
    feedback.set(draftKey, '正在保存…');
    renderDetail();
    try {
      await api(`/api/rooms/${encodeURIComponent(requestedRoom)}/claims`, { id: claim.id, ...values });
      // 保存期间继续编辑的内容留在表单，不能被较早的响应覆盖。
      savedDrafts.set(draftKey, values);
      feedback.set(draftKey, '标记已保存。');
    } catch (error) {
      feedback.set(draftKey, error.message || '保存失败，请重试。');
    } finally {
      pending.delete(operationKey);
      if (getCurrent()?.id === requestedRoom) sync(getCurrent());
    }
  };
  sync(getCurrent());
  return { sync, decorateMessage };
}
