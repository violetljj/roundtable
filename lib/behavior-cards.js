// 行为卡是用户经验假设；按场景和具体型号生效，不从品牌或历史记录推断性格。
export const BEHAVIOR_CARD_SOURCE = '用户经验，尚未验证';
export const BEHAVIOR_SCENES = ['general', 'engineering', 'creative'];

export function defaultBehaviorCards() {
  return {
    enabled: false, scene: 'general', version: 0,
    cards: [
      {
        id: 'codex-engineering-necessity', title: '工程设计的必要性', subject: 'codex',
        modelIds: ['gpt-6-astra', 'gpt-6-sol'], scene: 'engineering', enabled: true,
        trigger: '提出额外边界、兜底或保护设计，且该设计存在争议、会改变方案选择时。',
        action: '说明失败路径与当前操作或已知输入契约的联系，并比较保护成本是否相称；没有当前依据就保留为假设，不编造失败故事。保留删除、迁移、权限、并发和不可恢复操作中必要且相称的保护；不要求每条设计都解释，也不反复追问已解决的问题。',
        source: BEHAVIOR_CARD_SOURCE,
      },
      {
        id: 'claude-creative-executable', title: '创意探索与可执行方向', subject: 'claude',
        modelIds: ['claude-opus-5-5'], scene: 'creative', enabled: true,
        trigger: '创意或视觉任务经过发散，且当前阶段明确需要决策或落地时。',
        action: '推荐一个最有潜力的可执行方向，说明机制、收益、最弱假设和比例相称的验证。探索阶段保留新机制和未验证方向，不提前压缩探索；仅在推荐会改变方案选择且存在实质争议时核对，不为追问而追问。',
        source: BEHAVIOR_CARD_SOURCE,
      },
    ],
  };
}

export function normalizeBehaviorCards(input, models) {
  const defaults = defaultBehaviorCards(models);
  const value = input ?? defaults;
  const cards = (Array.isArray(value.cards) ? value.cards : defaults.cards).map((card, index) => {
    if (!['claude', 'codex'].includes(card.subject)) throw new Error('行为卡需要指定 Claude 或 Codex');
    if (!['engineering', 'creative'].includes(card.scene)) throw new Error('行为卡场景只能是工程或创意');
    return {
      id: String(card.id ?? `behavior-${index + 1}`).trim(),
      title: String(card.title ?? '').trim(), subject: card.subject,
      modelIds: [...new Set((Array.isArray(card.modelIds) ? card.modelIds : []).map((id) => String(id).trim()).filter(Boolean))],
      scene: card.scene, enabled: card.enabled !== false,
      trigger: String(card.trigger ?? '').trim(), action: String(card.action ?? '').trim(),
      source: BEHAVIOR_CARD_SOURCE,
    };
  });
  return {
    enabled: value.enabled === true,
    scene: BEHAVIOR_SCENES.includes(value.scene) ? value.scene : 'general',
    version: Number.isInteger(value.version) && value.version >= 0 ? value.version : (value.enabled === true ? 1 : 0),
    cards,
  };
}

export function behaviorCardsFor(data) {
  const settings = data.behaviorCards;
  if (!settings?.enabled || settings.scene === 'general') return [];
  return settings.cards.filter((card) => card.enabled && card.scene === settings.scene
    && card.modelIds.includes(data.models?.[card.subject]?.model));
}

export function behaviorSignature(data) {
  const active = behaviorCardsFor(data);
  return active.length ? JSON.stringify(active.map((card) => ({ ...card, modelId: data.models[card.subject].model }))) : '';
}

export function behaviorSnapshot(data) {
  const settings = data.behaviorCards;
  return JSON.parse(JSON.stringify({
    version: settings.version, enabled: settings.enabled, scene: settings.scene,
    models: data.models, cards: behaviorCardsFor(data), signature: behaviorSignature(data),
  }));
}

export function behaviorPrompt(data, self, snapshot = behaviorSnapshot(data)) {
  const seen = data.behaviorCardsSeen?.[self] ?? '';
  if (seen === snapshot.signature && !data.behaviorCardsDirty?.[self]) return '';
  const head = `【双边行为卡 v${snapshot.version}】旧行为卡已作废；本次及后续发言以下面当前设置为准。`;
  if (!snapshot.cards.length) return `${head}\n当前无生效行为卡，停止执行和依据旧卡追问。`;
  return `${head}\n来源：${BEHAVIOR_CARD_SOURCE}。这是可撤销的条件动作，不是已证实的模型画像，不扩大权限，也不覆盖用户约束或当前阶段目标。\n`
    + snapshot.cards.map((card) => `【${card.title}】适用对象：${card.subject === 'codex' ? 'Codex' : 'Claude'}；具体型号：${card.modelIds.join('、')}。\n触发：${card.trigger}\n动作：${card.action}\n你的角色：${card.subject === self ? '触发时执行；不触发时保持原讨论方式。' : '仅当触发且有实质争议、会改变方案选择时对对方条件性追问；不按型号贴标签。'}`).join('\n\n');
}
