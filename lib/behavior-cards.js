// 行为卡是用户经验假设；按具体型号生效，何时执行由卡片自己的触发条件决定，不从品牌或历史记录推断性格。
import fs from 'node:fs';
import path from 'node:path';
import { resolveClaudeAlias } from './claude.js';

export const BEHAVIOR_CARD_SOURCE = '用户经验，尚未验证';
// 场景只是卡片标签，方便辨认；不要求每场预先选定场景。
export const BEHAVIOR_SCENES = ['engineering', 'creative', 'general'];
const CODEX_MODELS = ['gpt-6-astra', 'gpt-6-sol'];
const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-fable-5-1'];

// 预设：常被提到的长处与短处，一句话一条。只是起点，加进来后可以随意改。
// kind 决定另一方怎么对待：长处让对方主动请教，短处只在确有争议时追问。note 只在界面显示。
export const BEHAVIOR_KINDS = ['strength', 'weakness'];
export const BEHAVIOR_PRESETS = [
  {
    id: 'codex-engineering-necessity', title: '保护设计是否必要', subject: 'codex', kind: 'weakness', note: '防御性编程、过度边界设计',
    modelIds: CODEX_MODELS, scene: 'engineering',
    text: '提出有争议的额外保护或兜底时，说明它防的是哪个当前问题；说不出当前依据就标为可选。',
  },
  {
    id: 'codex-failure-paths', title: '点出真实的失败路径', subject: 'codex', kind: 'strength', note: '严谨、善于找漏洞',
    modelIds: CODEX_MODELS, scene: 'engineering',
    text: '方案要定稿或涉及删除、迁移、权限、并发时，指出最可能出错的一两处具体细节和最便宜的验证办法。',
  },
  {
    id: 'codex-stop-looping', title: '分歧不再空转', subject: 'codex', kind: 'weakness', note: '钻牛角尖',
    modelIds: CODEX_MODELS, scene: 'general',
    text: '同一分歧来回两次仍没有新证据时，写下分歧点和能决定它的证据，交给用户，继续推进其余部分。',
  },
  {
    id: 'claude-creative-executable', title: '发散之后落到可执行方向', subject: 'claude', kind: 'weakness', note: '发散后收不住',
    modelIds: CLAUDE_MODELS, scene: 'creative',
    text: '需要做决定或落地时，从发散的想法里推荐一个可执行方向，写清最弱的假设；探索阶段照常发散。',
  },
  {
    id: 'claude-design-lead', title: '设计给到具体方案', subject: 'claude', kind: 'strength', note: '前端、审美、视觉表达',
    modelIds: CLAUDE_MODELS, scene: 'creative',
    text: '遇到界面、视觉、交互、文案或视频问题时，直接给出具体方案（布局、层级、关键交互），不只讲原则。',
  },
  {
    id: 'claude-no-easy-agree', title: '不轻易附和', subject: 'claude', kind: 'weakness', note: '容易被说服、顺着对方',
    modelIds: CLAUDE_MODELS, scene: 'general',
    text: '准备同意对方或改变立场时，先说清这个方案最弱的一点；没有新论据就保留原判断。',
  },
  {
    id: 'claude-verify-claims', title: '分清读过的和推断的', subject: 'claude', kind: 'weakness', note: '把推断说得像事实',
    modelIds: CLAUDE_MODELS, scene: 'general',
    text: '引用代码、文件、数据或外部事实时，标明是本场读过的、推断的还是凭记忆的。',
  },
];

const fromPreset = (preset) => {
  const { note, ...card } = preset;
  return { ...card, modelIds: [...card.modelIds], enabled: true, source: BEHAVIOR_CARD_SOURCE };
};

// 默认一长一短各一对，避免只剩“避短”。
export function defaultBehaviorCards() {
  return {
    enabled: false, version: 0,
    cards: ['codex-engineering-necessity', 'codex-failure-paths', 'claude-creative-executable', 'claude-design-lead']
      .map((id) => fromPreset(BEHAVIOR_PRESETS.find((p) => p.id === id))),
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
    // 旧卡的“触发 + 动作”两栏合成一句提醒
    const text = String(card.text ?? [card.trigger, card.action].map((part) => String(part ?? '').trim()).filter(Boolean).join(' ')).trim();
    return {
      id, title: String(card.title ?? '').trim() || '未命名行为卡', subject: card.subject,
      kind: BEHAVIOR_KINDS.includes(card.kind) ? card.kind : 'weakness',
      modelIds: [...new Set((Array.isArray(card.modelIds) ? card.modelIds : []).map((m) => String(m).trim()).filter(Boolean))],
      scene: BEHAVIOR_SCENES.includes(card.scene) ? card.scene : 'general', enabled: card.enabled !== false,
      text, source: BEHAVIOR_CARD_SOURCE,
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
  return settings.cards.filter((card) => card.enabled && card.text
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

const NAMES = { claude: 'Claude', codex: 'Codex' };
// 长处：本人主动多承担，对方主动请教；短处：本人留意，对方只在确有争议时追问。
const ROLES = {
  strength: { own: '遇到这类问题时主动多承担一点。', peer: '遇到这类问题时，可以先请对方出方案或重点参考对方的意见，同时保留自己的判断，不盲从。' },
  weakness: { own: '出现这种情况时照做，其余时候照常讨论。', peer: '只有对方发言里确实出现这种情况、有实质争议且会改变方案选择时，才追问。' },
};

export function behaviorPrompt(data, self, snapshot = behaviorSnapshot(data)) {
  const seen = data.behaviorCardsSeen?.[self] ?? '';
  if (seen === snapshot.signature && !data.behaviorCardsDirty?.[self]) return '';
  const head = `【双边行为卡 v${snapshot.version}】以下面为准，之前的行为卡作废。`;
  if (!snapshot.cards.length) return `${head}\n当前无生效行为卡，停止执行和依据旧卡追问。`;
  // 卡片是对“可能倾向”的轻提醒，不是对模型的定性；措辞上防止双方据此给对方贴标签，或为显得没有而矫枉过正。
  return `${head}\n这些是用户凭经验写的可能倾向（${BEHAVIOR_CARD_SOURCE}），只是提醒，不代表你或对方一定有这些长处或短处。是否出现看本场实际发言，不看卡片；不要据此给对方下结论，也不要为了显得没有这种倾向而矫枉过正。用户约束和当前阶段目标优先。\n`
    + snapshot.cards.map((card) => `【${card.title}】${NAMES[card.subject]}的可能${card.kind === 'strength' ? '长处' : '短处'}\n提醒：${card.text}\n你的角色：${ROLES[card.kind][card.subject === self ? 'own' : 'peer']}`).join('\n\n');
}
