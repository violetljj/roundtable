const SCENES = { general: '未指定场景', engineering: '工程与可靠性', creative: '创意与视觉' };
const NAMES = { codex: 'Codex', claude: 'Claude' };

export function initBehaviorCards({ api, getCurrent }) {
  const $ = (selector) => document.querySelector(selector);
  const section = $('#behaviorSection');
  const form = $('#behaviorForm');
  let editingRoom = null;
  let draft = null;

  function statusText(settings, models, card) {
    const status = !settings.enabled ? '本场总开关已关闭' : !card.enabled ? '这张卡已停用'
      : card.scene !== settings.scene ? '场景不匹配，本场不生效'
      : !card.modelIds.includes(models?.[card.subject]?.model) ? '当前型号不匹配，本场不生效' : '当前生效，触发时执行';
    return `${SCENES[card.scene]} · 用户经验，尚未验证 · ${status}。`;
  }

  function sync(current) {
    if (!current?.state) return;
    if (editingRoom && editingRoom !== current.id) close();
    const settings = current.state.behaviorCards;
    const preview = $('#behaviorPreview');
    if (!settings) {
      preview.textContent = '重启讨论室后可设置行为卡。';
      $('#editBehavior').disabled = true;
      return;
    }
    $('#editBehavior').disabled = false;
    const cards = settings.cards.filter((card) => card.enabled && card.scene === settings.scene
      && card.modelIds.includes(current.state.models?.[card.subject]?.model));
    preview.textContent = settings.enabled
      ? `${SCENES[settings.scene]} · ${cards.length ? cards.map((card) => card.title).join('、') : '当前没有匹配的卡片'} · v${settings.version}`
      : '已关闭；按需试用，初始规则来自用户经验，尚未验证。';
    if (!section.classList.contains('editing')) renderCards(settings, current.state.models);
  }

  function renderCards(settings, models) {
    const list = $('#behaviorCardList');
    list.replaceChildren();
    settings.cards.forEach((card, index) => {
      const article = document.createElement('fieldset');
      article.className = 'behavior-card';
      const legend = document.createElement('legend');
      legend.textContent = card.title;
      article.append(legend);
      const toggle = document.createElement('label');
      toggle.className = 'opt-check';
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = card.enabled; check.name = `card-${index}-enabled`;
      toggle.append(check, document.createTextNode(`启用这张卡 · ${NAMES[card.subject]} 执行，另一方按条件追问`));
      article.append(toggle);
      const info = document.createElement('p');
      info.className = 'fine';
      info.dataset.cardStatus = index;
      info.textContent = statusText(settings, models, card);
      article.append(info);
      for (const [key, label, multiline] of [['modelIds', '适用模型 ID（逗号分隔，精确匹配）', false], ['trigger', '触发条件', true], ['action', '触发后的动作', true]]) {
        const row = document.createElement('label');
        row.textContent = label;
        const input = document.createElement(multiline ? 'textarea' : 'input');
        input.name = `card-${index}-${key}`;
        input.value = key === 'modelIds' ? card.modelIds.join(', ') : card[key];
        if (multiline) input.rows = key === 'action' ? 4 : 2;
        input.required = true;
        row.append(input); article.append(row);
      }
      list.append(article);
    });
  }

  function close() {
    section.classList.remove('editing');
    editingRoom = null; draft = null;
  }

  $('#editBehavior').onclick = () => {
    if (section.classList.contains('editing')) return close();
    const current = getCurrent();
    if (!current?.state?.behaviorCards) return;
    editingRoom = current.id;
    draft = structuredClone(current.state.behaviorCards);
    $('#behaviorEnabled').checked = draft.enabled;
    $('#behaviorScene').value = draft.scene;
    renderCards(draft, current.state.models);
    $('#behaviorError').textContent = '';
    form.querySelector('[type="submit"]').disabled = false;
    section.classList.add('editing');
  };
  $('#cancelBehavior').onclick = close;
  $('#roomToolsDialog').addEventListener('close', close);
  form.addEventListener('change', () => {
    if (!draft) return;
    const settings = { enabled: $('#behaviorEnabled').checked, scene: $('#behaviorScene').value };
    draft.cards.forEach((card, index) => {
      const value = { ...card, enabled: form.elements[`card-${index}-enabled`].checked,
        modelIds: form.elements[`card-${index}-modelIds`].value.split(/[,，]/).map((id) => id.trim()).filter(Boolean) };
      form.querySelector(`[data-card-status="${index}"]`).textContent = statusText(settings, getCurrent()?.state?.models, value);
    });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!draft || editingRoom !== getCurrent()?.id) return;
    const roomId = editingRoom;
    const savedDraft = draft;
    const behaviorCards = { enabled: $('#behaviorEnabled').checked, scene: $('#behaviorScene').value,
      cards: draft.cards.map((card, index) => ({ ...card,
        enabled: form.elements[`card-${index}-enabled`].checked,
        modelIds: form.elements[`card-${index}-modelIds`].value.split(/[,，]/).map((id) => id.trim()).filter(Boolean),
        trigger: form.elements[`card-${index}-trigger`].value.trim(),
        action: form.elements[`card-${index}-action`].value.trim(),
      })),
    };
    if (behaviorCards.cards.some((card) => !card.modelIds.length || !card.trigger || !card.action)) {
      $('#behaviorError').textContent = '请填写模型 ID、触发条件和动作。'; return;
    }
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api(`/api/rooms/${roomId}/settings`, { behaviorCards });
      if (editingRoom === roomId && draft === savedDraft) close();
    } catch (error) {
      if (editingRoom === roomId && draft === savedDraft) $('#behaviorError').textContent = error.message;
    } finally { if (draft === savedDraft) button.disabled = false; }
  });
  return { sync };
}
