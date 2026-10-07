import { indexMessageLinks, experimentSeed } from './message-links.js';

const DISCUSSION = { unresolved: '尚未判断', consensus: '双方共识', disputed: '存在分歧' };
const EVIDENCE = { unverified: '待核实', supported: '有支持', counter: '有反证' };
const NAMES = { claude: 'Claude', codex: 'Codex' };

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function initClaimBoard({ api, getCurrent, openSource, draftExperiment, viewExperiment }) {
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
  document.getElementById('claimBoardHost').appendChild(board);

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
  const resultDialog = node('dialog', 'claim-dialog');
  resultDialog.id = 'checkResultDialog';
  resultDialog.setAttribute('aria-labelledby', 'checkResultTitle');
  resultDialog.innerHTML = `<div class="claim-head"><h3 id="checkResultTitle">原发言的核查与实验</h3><button type="button" class="icon-btn" data-close aria-label="关闭核查结果">×</button></div>
    <p class="claim-hint">下面保留实际回复和实验记录；对方同意不等于事实已验证。请打开回复查看理由和出处。</p>
    <div data-links></div><form class="claim-form"><label>你的判断<select name="evidence"><option value="unverified">仍不确定</option><option value="supported">有依据</option><option value="counter">需修正</option></select></label>
    <label>理由与出处<textarea name="note" rows="3" maxlength="4000" placeholder="说明哪些依据支持或反驳原判断，以及尚未验证什么"></textarea></label>
    <div class="claim-actions"><button type="submit" class="btn">保存我的判断</button><button type="button" class="link" data-original>回到原发言</button></div><p data-feedback class="claim-hint" role="status"></p></form>`;
  document.body.appendChild(resultDialog);
  const rq = (s) => resultDialog.querySelector(s);
  let resultMessageId = null;
  let experiment = null;
  let selection = null;
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
    document.getElementById('roomToolsDialog').close();
    resultDialog.close();
    document.getElementById('experimentDialog')?.close();
    document.getElementById('discussionTab').click();
    if (el.querySelector('.bubble.folded')) el.querySelector('[data-fold]')?.click();
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
    const links = indexMessageLinks(getCurrent()?.msgs?.values() ?? [], experiment);
    for (const el of document.querySelectorAll('.claim-message-actions')) {
      const id = el.dataset.messageId;
      const busy = pending.has(key(roomId, 'check:' + id));
      const button = el.querySelector('[data-check-message]');
      button.disabled = !canCheck() || busy;
      button.textContent = busy ? '正在发送…' : '请对方核查';
      button.title = checkHint();
      el.querySelector('[data-feedback]').textContent = feedback.get(key(roomId, 'message:' + id)) || (canCheck() ? '核查会消耗额度；起草不执行' : '独立提案结束后可核查');
      const draft = el.querySelector('[data-draft]');
      draft.disabled = !['discussion', 'done'].includes(getCurrent()?.state?.phase);
      const message = getCurrent()?.msgs?.get(id);
      const seed = experimentSeed(message?.text ?? '');
      draft.textContent = selection?.messageId === id ? '据选文起草小实验' : seed.suggested ? '查看实验建议' : '据此起草小实验';
      const related = links.get(id);
      const result = el.querySelector('[data-result]');
      const replies = [...new Map((related?.checks.flatMap((c) => c.responses) ?? []).map((m) => [m.id, m])).values()];
      const records = related?.experiments ?? [];
      const latest = records.at(-1);
      const experimentStatus = { draft: '待批准', running: '进行中', completed: '报告待判断', failed: '未完成', cancelled: '已取消', returned: latest?.responses.length ? '已重新判断' : '待重新判断' }[latest?.status];
      result.hidden = !related?.checks.length && !records.length;
      const annotation = getCurrent()?.state?.messageAnnotations?.[id];
      const judgment = { supported: '有依据（你标记）', counter: '需修正（你标记）', unverified: '仍不确定（你标记）' }[annotation?.evidence];
      result.textContent = [judgment, related?.checks.length ? replies.length ? `核查回复 ${replies.length} 条` : '核查待回复' : '', latest ? `实验${records.length > 1 ? ` ${records.length} 项` : ''} · ${experimentStatus}` : ''].filter(Boolean).join(' · ') + ' →';
    }
    if (resultDialog.open) renderResultLinks();
  }

  function renderResultLinks() {
    const links = indexMessageLinks(getCurrent()?.msgs?.values() ?? [], experiment).get(resultMessageId);
    const container = rq('[data-links]');
    container.replaceChildren();
    const jump = (label, id) => {
      const button = node('button', 'link check-result-link', label);
      button.type = 'button'; button.onclick = () => goToMessage(id);
      container.appendChild(button);
    };
    for (const { request, responses } of links?.checks ?? []) {
      jump(responses.length ? '查看核查请求' : '核查尚无关联完整回复 · 查看请求', request.id);
      for (const reply of responses) jump(`${NAMES[reply.from]} 的核查回复 →`, reply.id);
      if (!responses.length && request.answeredBy?.[request.target]) container.appendChild(node('p', 'claim-hint', '这条旧记录未保存回复关联，不按时间猜测核查结果。'));
    }
    for (const record of links?.experiments ?? []) {
      const label = { draft: '待批准', running: '进行中', completed: '报告已生成，待判断', failed: '未完成', cancelled: '已取消', returned: record.responses.length ? `已带回讨论，${record.responses.length} 条重新判断` : '已带回讨论，待重新判断' }[record.status] ?? record.status;
      const button = node('button', 'link check-result-link', `实验：${label} · ${record.card?.question || '查看实验卡'} →`);
      button.type = 'button';
      button.onclick = () => { resultDialog.close(); viewExperiment?.(record.id); };
      container.appendChild(button);
    }
    for (const reply of links?.assessments ?? []) jump(`${NAMES[reply.from]} 对实验的重新判断 →`, reply.id);
  }

  function openResult(messageId) {
    resultMessageId = messageId;
    const values = drafts.get(key(roomId, 'result:' + messageId)) ?? getCurrent()?.state?.messageAnnotations?.[messageId] ?? {};
    rq('[name="evidence"]').value = values.evidence ?? 'unverified';
    rq('[name="note"]').value = values.note ?? '';
    rq('[data-feedback]').textContent = '';
    renderResultLinks();
    document.getElementById('roomToolsDialog').close();
    resultDialog.showModal();
  }

  function sync(current) {
    if (current?.id !== roomId) {
      roomId = current?.id || null;
      selectedId = null;
      board.open = false;
      experiment = null;
      selection = null;
      resultMessageId = null;
      resultDialog.close();
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
      list.appendChild(node('p', 'claim-hint', current?.state?.claimCards
        ? '发言中的【主张】会汇集到这里。也可在任意完整发言下请另一方核查。'
        : '本场没有要求标注主张（新建讨论时可开启）。仍可在任意完整发言下请另一方核查。'));
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
    const linkedRequests = (message.responseToMessageIds ?? []).map((id) => getCurrent()?.msgs?.get(id)).filter((m) => m?.relatedMessageId);
    const relatedIds = [...new Set([message.relatedMessageId, ...linkedRequests.map((m) => m.relatedMessageId)].filter(Boolean))];
    for (const relatedId of relatedIds) {
      if ([...element.querySelectorAll('[data-return-original]')].some((el) => el.dataset.returnOriginal === relatedId)) continue;
      const back = node('button', 'link check-result-link', relatedIds.length > 1 ? `回到原发言 ${relatedIds.indexOf(relatedId) + 1} →` : '回到被核查 / 实验的原发言 →');
      back.type = 'button'; back.dataset.returnOriginal = relatedId;
      back.onclick = () => goToMessage(relatedId);
      element.querySelector('.bubble')?.appendChild(back);
    }
    if (!['claude', 'codex'].includes(message.from) || message.status !== 'complete') return;
    const bubble = element.querySelector('.bubble');
    if (!bubble || bubble.querySelector('.claim-message-actions')) return;
    const actions = node('div', 'claim-message-actions');
    actions.dataset.messageId = message.id;
    const button = node('button', 'btn', '请对方核查');
    button.dataset.checkMessage = '';
    button.type = 'button';
    const renderedRoom = getCurrent()?.id;
    button.onclick = () => {
      if (getCurrent()?.id === renderedRoom) requestCheck(message.id);
    };
    const status = node('span', 'claim-hint');
    status.dataset.feedback = '';
    status.setAttribute('role', 'status');
    const draft = node('button', 'btn', '据此起草小实验');
    draft.type = 'button'; draft.dataset.draft = '';
    draft.onclick = () => {
      if (getCurrent()?.id !== renderedRoom) return;
      const selected = selection?.messageId === message.id ? selection.text : '';
      const text = getCurrent().msgs.get(message.id)?.text ?? message.text;
      draftExperiment?.({ sourceMessageId: message.id, sourceExcerpt: (selected && text.includes(selected) ? selected : text).slice(0, 12000), ...experimentSeed(text, selected) });
    };
    draft.title = '起草不调用模型；保存会暂停讨论，批准执行后才消耗模型额度。可先选中正文中的文字。';
    const result = node('button', 'link', '查看核查与实验 →');
    result.type = 'button'; result.dataset.result = ''; result.hidden = true;
    result.onclick = () => openResult(message.id);
    actions.append(button, draft, result, status);
    bubble.appendChild(actions);
    refreshButtons();
  }

  q('[data-close]').onclick = () => dialog.close();
  rq('[data-close]').onclick = () => resultDialog.close();
  rq('[data-original]').onclick = () => goToMessage(resultMessageId);
  rq('form').oninput = () => { if (roomId && resultMessageId) drafts.set(key(roomId, 'result:' + resultMessageId), { evidence: rq('[name="evidence"]').value, note: rq('[name="note"]').value }); };
  rq('form').onsubmit = async (event) => {
    event.preventDefault();
    const requestedRoom = roomId, messageId = resultMessageId;
    const button = rq('[type="submit"]');
    const body = { messageId, evidence: rq('[name="evidence"]').value, note: rq('[name="note"]').value.trim() };
    button.disabled = true;
    try {
      await api(`/api/rooms/${encodeURIComponent(requestedRoom)}/claims`, body);
      if (getCurrent()?.id === requestedRoom) {
        (getCurrent().state.messageAnnotations ??= {})[messageId] = { evidence: body.evidence, note: body.note };
        const draftKey = key(requestedRoom, 'result:' + messageId);
        const draft = drafts.get(draftKey);
        if (!draft || (draft.evidence === body.evidence && draft.note.trim() === body.note)) drafts.delete(draftKey);
        refreshButtons();
        if (resultMessageId === messageId) rq('[data-feedback]').textContent = '你的判断已保存；可随新证据修改。';
      }
    } catch (error) { if (getCurrent()?.id === requestedRoom && resultMessageId === messageId) rq('[data-feedback]').textContent = error.message; }
    finally { button.disabled = false; }
  };
  document.addEventListener('selectionchange', () => {
    const selected = window.getSelection();
    if (!selected?.rangeCount || selected.isCollapsed) return;
    const range = selected.getRangeAt(0);
    const body = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('.msg .body');
    if (!body || !body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
    const messageId = body.closest('.msg').id.slice(2);
    const message = getCurrent()?.msgs?.get(messageId);
    if (!['claude', 'codex'].includes(message?.from) || message.status !== 'complete') return;
    selection = { messageId, text: selected.toString().trim().slice(0, 12000) };
    refreshButtons();
  });
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
  return { sync, decorateMessage, updateExperiment(id, value) { if (id === roomId) { experiment = value; refreshButtons(); } } };
}
