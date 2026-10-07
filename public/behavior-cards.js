// 本场设置里的双边行为卡：开关、勾选、添加、删除点了就保存；规则文字点「调整」才展开。
// 每次保存也会成为之后新讨论的默认卡片（服务端负责），直到下次修改。
const NAMES = { codex: 'Codex', claude: 'Claude' };
const KINDS = { strength: '长处', weakness: '短处' };

let catalogLoading = null;
// 预设、默认卡片和型号建议；新建窗口也用它显示将沿用哪些卡。
export function loadBehaviorCatalog(api, fresh = false) {
  if (fresh || !catalogLoading) catalogLoading = api('/api/behavior-cards').catch(() => { catalogLoading = null; return null; });
  return catalogLoading;
}

export function initBehaviorCards({ api, getCurrent }) {
  const $ = (selector) => document.querySelector(selector);
  const list = $('#behaviorCardList');
  const enabledInput = $('#behaviorEnabled');
  const errorBox = $('#behaviorError');
  const pill = $('#behaviorPill');
  const addBtn = $('#behaviorAdd');
  const addMenu = $('#behaviorAddMenu');
  let editing = null; // { roomId, cardId }
  let saving = false;
  let pendingEdit = null; // 刚加的空白卡，出现在列表里后直接展开编辑

  // 服务端按命令行实际型号解析别名；旧服务没有这个字段时退回原始值。
  const modelIdOf = (state, subject) => state.behaviorModelIds?.[subject] ?? state.models?.[subject]?.model ?? '';
  const isActive = (state, card) => state.behaviorActive ? state.behaviorActive.includes(card.id)
    : state.behaviorCards.enabled && card.enabled && card.modelIds.includes(modelIdOf(state, card.subject));

  function statusOf(state, card) {
    if (!card.enabled) return ['off', ''];
    const id = modelIdOf(state, card.subject);
    if (!card.modelIds.includes(id)) return ['mismatch', `不适用当前 ${NAMES[card.subject]}（${id || '未知型号'}）`];
    return [state.behaviorCards.enabled ? 'on' : 'idle', ''];
  }

  function renderPill(state) {
    const settings = state.behaviorCards;
    if (!settings?.enabled) { pill.classList.add('hidden'); return; }
    const active = settings.cards.filter((card) => isActive(state, card));
    pill.classList.remove('hidden');
    pill.classList.toggle('warn', !active.length);
    pill.textContent = active.length ? `行为卡 · ${active.length}` : '行为卡 · 未匹配';
    pill.title = active.length ? `${active.map((card) => `${card.title}（${NAMES[card.subject]}）`).join('\n')}\n点击调整` : '没有卡片匹配当前型号，点击调整';
  }

  function sync(current) {
    const state = current?.state;
    if (!state) return;
    if (editing && editing.roomId !== current.id) editing = null;
    const settings = state.behaviorCards;
    if (!settings) {
      $('#behaviorPreview').textContent = '重启讨论室后可设置行为卡。';
      enabledInput.disabled = addBtn.disabled = true;
      pill.classList.add('hidden');
      return;
    }
    enabledInput.disabled = addBtn.disabled = saving;
    enabledInput.checked = settings.enabled;
    $('#behaviorVer').textContent = settings.version ? `v${settings.version}` : '';
    $('#behaviorSection').classList.toggle('off', !settings.enabled);
    const activeCards = settings.cards.filter((card) => isActive(state, card));
    const active = activeCards.length;
    const strengths = activeCards.filter((card) => card.kind === 'strength').length;
    $('#behaviorPreview').textContent = !settings.enabled ? '打开后，勾选的卡会作为“可能的倾向”提醒双方扬长避短，不是给模型下定论。规则来自你的经验，可以随时改。'
      : active ? `${active} 张生效（长处 ${strengths} · 短处 ${active - strengths}）。长处卡让对方主动请教，短处卡对方只在确有争议时追问。`
      : '没有卡片匹配当前型号。';
    renderPill(state);
    if (!editing) renderCards(state);
  }

  function renderCards(state) {
    list.replaceChildren();
    for (const card of state.behaviorCards.cards) {
      const [kind, note] = statusOf(state, card);
      const item = document.createElement('div');
      item.className = 'bcard';
      item.dataset.state = kind;
      const head = document.createElement('div');
      head.className = 'bcard-head';
      const toggle = document.createElement('label');
      toggle.className = 'bcard-toggle';
      toggle.title = card.text || '还没写提醒内容';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = card.enabled; check.disabled = saving;
      check.onchange = () => save((next) => { next.cards.find((c) => c.id === card.id).enabled = check.checked; });
      const title = document.createElement('span');
      title.textContent = card.title;
      const who = document.createElement('span');
      who.className = `bcard-who ${card.subject}`;
      who.textContent = NAMES[card.subject];
      const kindTag = document.createElement('span');
      kindTag.className = `bcard-kind ${card.kind}`;
      kindTag.textContent = KINDS[card.kind];
      toggle.append(check, title, who, kindTag);
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'link'; edit.textContent = '调整';
      edit.onclick = () => openEditor(item, card);
      head.append(toggle, edit);
      item.append(head);
      if (note) {
        const status = document.createElement('p');
        status.className = 'bcard-status';
        status.textContent = note;
        item.append(status);
      }
      list.append(item);
      if (pendingEdit === card.id) { pendingEdit = null; queueMicrotask(() => openEditor(item, card)); }
    }
    if (!state.behaviorCards.cards.length) {
      const empty = document.createElement('p');
      empty.className = 'fine';
      empty.textContent = '还没有卡片，点「＋ 添加」从常见长短处里挑。';
      list.append(empty);
    }
  }

  async function openEditor(item, card) {
    editing = { roomId: getCurrent().id, cardId: card.id };
    item.classList.add('editing');
    let subject = card.subject;
    let kind = card.kind;
    const form = document.createElement('form');
    form.className = 'bcard-edit';
    form.innerHTML = `
      <label>名称<input name="title" required></label>
      <div class="bcard-subject">
        <div class="seg" role="group" aria-label="提醒谁"><button type="button" data-s="claude">Claude</button><button type="button" data-s="codex">Codex</button></div>
        <div class="seg" role="group" aria-label="长处还是短处"><button type="button" data-k="strength">长处</button><button type="button" data-k="weakness">短处</button></div></div>
      <label>提醒<textarea name="text" rows="3" required placeholder="一两句话，比如：遇到界面问题时，直接给出具体方案，不只讲原则。"></textarea></label>
      <p class="fine bcard-kind-hint"></p>
      <label>适用型号<input name="modelIds" required placeholder="完整型号 ID，逗号分隔"></label>
      <div class="bcard-chips"></div>
      <div class="inline-actions"><button type="button" class="link danger bcard-del">删除这张卡</button><span class="spacer"></span>
        <button type="button" class="btn sm ghost bcard-cancel">取消</button><button type="submit" class="btn sm primary">保存</button></div>`;
    form.elements.title.value = card.title;
    form.elements.text.value = card.text;
    form.elements.modelIds.value = card.modelIds.join(', ');
    const segButtons = [...form.querySelectorAll('[data-s]')];
    const kindButtons = [...form.querySelectorAll('[data-k]')];
    const catalog = await loadBehaviorCatalog(api);
    const chips = form.querySelector('.bcard-chips');
    const ids = () => form.elements.modelIds.value.split(/[,，\s]+/).map((id) => id.trim()).filter(Boolean);
    // 点型号建议即可加入或移出，免得手打完整 ID
    function renderChips() {
      segButtons.forEach((b) => { b.classList.toggle('on', b.dataset.s === subject); b.setAttribute('aria-pressed', String(b.dataset.s === subject)); });
      kindButtons.forEach((b) => { b.classList.toggle('on', b.dataset.k === kind); b.setAttribute('aria-pressed', String(b.dataset.k === kind)); });
      // 写明对方会怎么对待这张卡，长短处的区别一眼可见
      const other = NAMES[subject === 'claude' ? 'codex' : 'claude'];
      form.querySelector('.bcard-kind-hint').textContent = kind === 'strength'
        ? `遇到这类问题时，${other} 会先请 ${NAMES[subject]} 出方案或重点参考它的意见。`
        : `${other} 只在 ${NAMES[subject]} 确实出现这种情况、而且有争议时追问。`;
      const state = getCurrent()?.state;
      const choices = [...new Set([...(catalog?.modelChoices?.[subject] ?? []), state ? modelIdOf(state, subject) : ''].filter(Boolean))];
      chips.replaceChildren(...choices.map((id) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (ids().includes(id) ? ' on' : '');
        chip.textContent = id;
        chip.onclick = () => {
          const now = ids();
          form.elements.modelIds.value = (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]).join(', ');
          renderChips();
        };
        return chip;
      }));
    }
    segButtons.forEach((b) => { b.onclick = () => { subject = b.dataset.s; renderChips(); }; });
    kindButtons.forEach((b) => { b.onclick = () => { kind = b.dataset.k; renderChips(); }; });
    form.elements.modelIds.addEventListener('input', renderChips);
    renderChips();
    form.querySelector('.bcard-cancel').onclick = closeEditor;
    form.querySelector('.bcard-del').onclick = async () => {
      if (!confirm(`删除「${card.title}」？`)) return;
      if (await save((next) => { next.cards = next.cards.filter((c) => c.id !== card.id); })) closeEditor();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      const changes = { title: form.elements.title.value.trim(), subject, kind, modelIds: ids(), text: form.elements.text.value.trim() };
      if (!changes.modelIds.length) { errorBox.textContent = '至少选一个适用型号。'; return; }
      if (await save((next) => Object.assign(next.cards.find((c) => c.id === card.id), changes))) closeEditor();
    };
    item.append(form);
    form.elements.text.focus();
  }

  function closeEditor() {
    editing = null;
    errorBox.textContent = '';
    sync(getCurrent());
  }

  // 以服务端当前设置为底稿修改后整体保存，不拿旧草稿覆盖。
  async function save(mutate) {
    const current = getCurrent();
    const settings = current?.state?.behaviorCards;
    if (!settings || saving) return false;
    const next = structuredClone(settings);
    mutate(next);
    saving = true;
    errorBox.textContent = '';
    try {
      await api(`/api/rooms/${current.id}/settings`, { behaviorCards: next });
      loadBehaviorCatalog(api, true);
      return true;
    } catch (error) {
      errorBox.textContent = error.message;
      return false;
    } finally {
      saving = false;
      if (getCurrent()?.id === current.id) sync(getCurrent());
    }
  }

  // 「＋ 添加」：未加入的预设按 Claude / Codex 分组，最后是空白卡
  async function openAddMenu() {
    const catalog = await loadBehaviorCatalog(api);
    const state = getCurrent()?.state;
    if (!state?.behaviorCards) return;
    const have = new Set(state.behaviorCards.cards.map((c) => c.id));
    addMenu.replaceChildren();
    for (const subject of ['claude', 'codex']) {
      const presets = (catalog?.presets ?? []).filter((p) => p.subject === subject && !have.has(p.id));
      if (!presets.length) continue;
      const group = document.createElement('div');
      group.className = 'menu-group';
      group.textContent = NAMES[subject];
      addMenu.append(group);
      for (const preset of presets) {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.innerHTML = '<b></b><span></span>';
        button.querySelector('b').textContent = preset.title;
        button.querySelector('span').textContent = `${KINDS[preset.kind]}：${preset.note}`;
        button.title = preset.text;
        button.onclick = () => addCard(preset);
        addMenu.append(button);
      }
    }
    const blank = document.createElement('button');
    blank.type = 'button';
    blank.setAttribute('role', 'menuitem');
    blank.className = 'menu-blank';
    blank.textContent = '空白卡片，自己写';
    blank.onclick = () => addCard(null);
    addMenu.append(blank);
    toggleAdd(true);
  }

  async function addCard(preset) {
    toggleAdd(false);
    const state = getCurrent()?.state;
    const subject = preset?.subject ?? 'claude';
    const card = preset
      ? { id: preset.id, title: preset.title, subject, kind: preset.kind, modelIds: [...preset.modelIds], scene: preset.scene, text: preset.text, enabled: true }
      : { id: `custom-${Date.now().toString(36)}`, title: '新行为卡', subject, kind: 'weakness', modelIds: [modelIdOf(state, subject)].filter(Boolean), scene: 'general', text: '', enabled: true };
    // 空白卡先存下来再展开编辑；没写触发和动作之前不会发给模型
    if (!preset) pendingEdit = card.id;
    if (!await save((next) => { next.cards.push(card); })) pendingEdit = null;
  }

  function toggleAdd(open) {
    const on = open ?? addMenu.classList.contains('hidden');
    addMenu.classList.toggle('hidden', !on);
    addBtn.setAttribute('aria-expanded', String(on));
  }

  enabledInput.onchange = () => save((next) => { next.enabled = enabledInput.checked; });
  addBtn.onclick = (e) => { e.stopPropagation(); if (addMenu.classList.contains('hidden')) openAddMenu(); else toggleAdd(false); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.bcard-add')) toggleAdd(false); });
  pill.onclick = () => {
    $('#roomToolsBtn').click();
    requestAnimationFrame(() => $('#behaviorSection').scrollIntoView({ block: 'start' }));
  };
  $('#roomToolsDialog').addEventListener('close', () => { toggleAdd(false); if (editing) closeEditor(); });
  return { sync };
}
