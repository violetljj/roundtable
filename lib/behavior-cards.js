// 行为卡是用户经验假设；按具体型号生效，何时执行由卡片自己的触发条件决定，不从品牌或历史记录推断性格。
import fs from 'node:fs';
import path from 'node:path';
import { resolveClaudeAlias } from './claude.js';

export const BEHAVIOR_CARD_SOURCE = '用户经验，尚未验证';
// 场景只是卡片标签，方便辨认；不要求每场预先选定场景。
export const BEHAVIOR_SCENES = ['engineering', 'creative', 'general'];
const CODEX_MODELS = ['gpt-6-astra', 'gpt-6-sol'];
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-fable-5-1'];

// 预设：常被提到的长处与短处，写成“触发 → 动作”。只是起点，加进来后可以随意改。
export const BEHAVIOR_PRESETS = [
  {
    id: 'codex-engineering-necessity', title: '保护设计是否必要', subject: 'codex', kind: '短处：防御性编程、过度边界设计',
    modelIds: CODEX_MODELS, scene: 'engineering',
    trigger: '工程或可靠性设计中，提出额外的边界、兜底或保护，而且这项设计有争议、会改变方案选择。',
    action: '说明它防的失败路径和当前操作或已知输入契约有什么联系，保护成本是否相称；说不出当前依据就标为假设，不编失败故事。删除、迁移、权限、并发和不可恢复操作中相称的保护照常保留。',
  },
  {
    id: 'codex-stop-looping', title: '分歧不再空转', subject: 'codex', kind: '短处：钻牛角尖',
    modelIds: CODEX_MODELS, scene: 'general',
    trigger: '同一个分歧已经来回交锋两次，双方都没有拿出新证据或新论点。',
    action: '停止重复论证，用一句话写下分歧点和能决定它的证据或小实验，交给用户裁决，然后继续推进其余部分。',
  },
  {
    id: 'codex-failure-paths', title: '点出真实的失败路径', subject: 'codex', kind: '长处：严谨、善于找漏洞',
    modelIds: CODEX_MODELS, scene: 'engineering',
    trigger: '方案准备定稿或进入实现前。',
    action: '指出最可能让方案失败的一两处具体细节（哪个文件、哪种输入、哪一步操作），附上最便宜的验证办法；没有具体依据就不列。',
  },
  {
    id: 'claude-creative-executable', title: '发散之后落到可执行方向', subject: 'claude', kind: '短处：发散后收不住',
    modelIds: CLAUDE_MODELS, scene: 'creative',
    trigger: '创意、视觉或产品设计已经发散过，而且当前需要做决定或落地。',
    action: '推荐一个最值得做的可执行方向，写清机制、收益、最弱的假设和相称的验证。探索阶段照常发散，不提前收窄。',
  },
  {
    id: 'claude-design-lead', title: '设计给到具体方案', subject: 'claude', kind: '长处：前端、审美、视觉表达',
    modelIds: CLAUDE_MODELS, scene: 'creative',
    trigger: '问题涉及界面、视觉、交互、文案或视频。',
    action: '给出具体方案：布局和信息层级、关键交互、文案或分镜大致的样子，并说明取舍理由；不要只停在设计原则。',
  },
  {
    id: 'claude-no-easy-agree', title: '不轻易附和', subject: 'claude', kind: '短处：容易被说服、顺着对方',
    modelIds: CLAUDE_MODELS, scene: 'general',
    trigger: '准备同意对方或用户的方案，或者被反驳后准备改变立场时。',
    action: '先指出这个方案最弱的一点再表态；改变立场时说明是哪条新论据让你改的，没有新论据就保留原来的判断。',
  },
  {
    id: 'claude-verify-claims', title: '分清读过的和推断的', subject: 'claude', kind: '短处：把推断说得像事实',
    modelIds: CLAUDE_MODELS, scene: 'general',
    trigger: '引用代码行为、文件内容、数据或外部事实时。',
    action: '标明这是本场读过的、推断的，还是凭记忆的；没读过就写“未核实”，不要用肯定的语气带过。',
  },
];

const fromPreset = (preset) => {
  const { kind, ...card } = preset;
  return { ...card, modelIds: [...card.modelIds], enabled: true, source: BEHAVIOR_CARD_SOURCE };
};

export function defaultBehaviorCards() {
  return {
    enabled: false, version: 0,
    cards: ['codex-engineering-necessity', 'claude-creative-executable'].map((id) => fromPreset(BEHAVIOR_PRESETS.find((p) => p.id === id))),
  };
}

export function normalizeBehaviorCards(input) {
  const defaults = defaultBehaviorCards();
  const value = input ?? defaults;
  const seen = new Set();
  const cards = (Array.isArray(value.cards) ? value.cards : defaults.cards).map((card, index) => {
    if (!['claude', 'codex'].includes(card.subject)) throw new Error('行为卡需要指定 Claude 或 Codex');
    let id = String(card.id ?? '').trim() || `behavior-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return {
      id, title: String(card.title ?? '').trim() || '未命名行为卡', subject: card.subject,
      modelIds: [...new Set((Array.isArray(card.modelIds) ? card.modelIds : []).map((m) => String(m).trim()).filter(Boolean))],
      scene: BEHAVIOR_SCENES.includes(card.scene) ? card.scene : 'general', enabled: card.enabled !== false,
      trigger: String(card.trigger ?? '').trim(), action: String(card.action ?? '').trim(),
      source: BEHAVIOR_CARD_SOURCE,
    };
  });
  return {
    enabled: value.enabled === true,
    version: Number.isInteger(value.version) && value.version >= 0 ? value.version : (value.enabled === true ? 1 : 0),
    cards,
  };
}

// 最近一次修改的卡片组（含开关）作为新讨论的默认值，直到下次修改；每场讨论仍各存一份，互不影响。
const defaultsFile = (roomsDir) => path.join(roomsDir, '.behavior-cards.json');

export function loadBehaviorDefaults(roomsDir) {
  try {
    const { enabled, cards } = normalizeBehaviorCards(JSON.parse(fs.readFileSync(defaultsFile(roomsDir), 'utf8')));
    return { enabled, cards };
  } catch {
    const { enabled, cards } = defaultBehaviorCards();
    return { enabled, cards };
  }
}

export function saveBehaviorDefaults(roomsDir, settings) {
  const { enabled, cards } = normalizeBehaviorCards(settings);
  fs.writeFileSync(defaultsFile(roomsDir), JSON.stringify({ enabled, cards, savedAt: Date.now() }, null, 2));
}

// 新建时没有明确给出的部分沿用默认值。
export function inheritBehaviorCards(requested, defaults) {
  return { enabled: requested?.enabled ?? defaults.enabled, cards: requested?.cards ?? defaults.cards };
}

// Claude 的别名（opus / fable / 命令行默认）按命令行实际报告的完整型号匹配，仍是精确型号，不按品牌推断。
export function effectiveModelId(subject, model) {
  return subject === 'claude' ? resolveClaudeAlias(model ?? '') ?? '' : String(model ?? '');
}

export function behaviorModelIds(data) {
  return { claude: effectiveModelId('claude', data.models?.claude?.model), codex: effectiveModelId('codex', data.models?.codex?.model) };
}

export function behaviorCardsFor(data) {
  const settings = data.behaviorCards;
  if (!settings?.enabled) return [];
  const ids = behaviorModelIds(data);
  return settings.cards.filter((card) => card.enabled && card.trigger && card.action
    && ids[card.subject] && card.modelIds.includes(ids[card.subject]));
}

export function behaviorSignature(data) {
  const active = behaviorCardsFor(data);
  const ids = behaviorModelIds(data);
  return active.length ? JSON.stringify(active.map((card) => ({ ...card, modelId: ids[card.subject] }))) : '';
}

export function behaviorSnapshot(data) {
  const settings = data.behaviorCards;
  return JSON.parse(JSON.stringify({
    version: settings.version, enabled: settings.enabled,
    models: data.models, cards: behaviorCardsFor(data), signature: behaviorSignature(data),
  }));
}

export function behaviorPrompt(data, self, snapshot = behaviorSnapshot(data)) {
  const seen = data.behaviorCardsSeen?.[self] ?? '';
  if (seen === snapshot.signature && !data.behaviorCardsDirty?.[self]) return '';
  const head = `【双边行为卡 v${snapshot.version}】以下面为准，之前的行为卡作废。`;
  if (!snapshot.cards.length) return `${head}\n当前无生效行为卡，停止执行和依据旧卡追问。`;
  // 卡片是对“可能倾向”的轻提醒，不是对模型的定性；措辞上防止双方据此给对方贴标签，或为显得没有而矫枉过正。
  return `${head}\n这些是用户凭经验写的可能倾向（${BEHAVIOR_CARD_SOURCE}），只是提醒，不代表你或对方一定有这些长处或短处。是否出现看本场实际发言，不看卡片；不要据此给对方下结论，也不要为了显得没有这种倾向而矫枉过正。用户约束和当前阶段目标优先。\n`
    + snapshot.cards.map((card) => `【${card.title}】提醒 ${card.subject === 'codex' ? 'Codex' : 'Claude'}。\n如果：${card.trigger}\n可以：${card.action}\n你的角色：${card.subject === self ? '出现这种情况时照做，其余时候照常讨论。' : '只有对方发言里确实出现这种情况、有实质争议且会改变方案选择时，才条件性追问。'}`).join('\n\n');
}
