// 检查实际送入的提示与调度状态，不把模拟流程当作真实模型行为改善。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../lib/room.js';
import { defaultBehaviorCards, normalizeBehaviorCards, behaviorCardsFor, behaviorSignature, behaviorPrompt, loadBehaviorDefaults, saveBehaviorDefaults, inheritBehaviorCards, BEHAVIOR_PRESETS } from '../lib/behavior-cards.js';

const models = { codex: { model: 'gpt-6-astra', effort: 'high' }, claude: { model: 'claude-opus-5-5', effort: 'high' } };
function settings() { return { ...defaultBehaviorCards(), enabled: true }; }
function agent(name) {
  return {
    name, prompts: [], turns: [],
    send(prompt, cb) {
      this.prompts.push(prompt);
      return new Promise((resolve) => this.turns.push({ finish(status = 'completed', text = `${name} 完整方案\n【状态】可以收敛`) {
        if (status === 'completed') cb.onDelta?.(text);
        resolve({ status, text, error: status === 'failed' ? '模拟失败' : undefined });
      } }));
    },
    interrupt() { this.turns.at(-1)?.finish('interrupted', ''); },
  };
}
async function waitFor(check) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('等待模拟状态超时'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function makeRoom(t, opts = {}) {
  const roomsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-behavior-'));
  const agents = { claude: agent('claude'), codex: agent('codex') };
  const room = Room.create({ topic: '工程方案', maxRounds: 3, maxTurns: 0, ...opts }, { roomsDir, agentFactory: () => agents });
  t.after(async () => { room.stop(); await waitFor(() => !room.pumping); clearTimeout(room.saveTimer); fs.rmSync(roomsDir, { recursive: true }); });
  return { room, ...agents };
}
async function discussion(ctx) {
  ctx.room.start();
  await waitFor(() => ctx.claude.turns.length === 1 && ctx.codex.turns.length === 1);
  ctx.claude.turns[0].finish(); ctx.codex.turns[0].finish();
  await waitFor(() => ctx.claude.turns.length === 2);
}

test('默认关闭；开启后按具体型号匹配，Claude 别名按实际型号解析，未知型号不推断', () => {
  const data = { models, behaviorCards: defaultBehaviorCards() };
  assert.deepEqual(behaviorCardsFor(data), []);
  assert.equal(behaviorPrompt(data, 'codex'), '');
  data.behaviorCards = settings();
  assert.deepEqual(behaviorCardsFor(data).map((card) => card.subject), ['codex', 'codex', 'claude', 'claude']);
  data.models = { ...models, codex: { model: 'gpt-6-astra-next' } };
  assert.deepEqual(behaviorCardsFor(data).map((card) => card.subject), ['claude', 'claude']);
  data.models = { ...models, codex: { model: '' } };
  assert.deepEqual(behaviorCardsFor(data).map((card) => card.subject), ['claude', 'claude']);
  // opus 和命令行默认都解析成 claude-opus-5-5；haiku 不在适用型号里
  for (const alias of ['opus', '', 'fable']) {
    data.models = { ...models, claude: { model: alias } };
    assert.ok(behaviorCardsFor(data).some((card) => card.subject === 'claude'), alias);
  }
  data.models = { ...models, claude: { model: 'haiku' } };
  assert.ok(!behaviorCardsFor(data).some((card) => card.subject === 'claude'));
  const edited = settings();
  edited.cards[0].modelIds = ['custom-model'];
  data.behaviorCards = normalizeBehaviorCards(edited);
  data.models = { ...models, codex: { model: 'custom-model' } };
  assert.ok(behaviorCardsFor(data).some((card) => card.subject === 'codex'));
  // 没写完触发和动作的空白卡不发给模型
  data.behaviorCards = normalizeBehaviorCards({ ...data.behaviorCards, cards: [...data.behaviorCards.cards,
    { id: 'blank', title: '新行为卡', subject: 'codex', modelIds: ['custom-model'], text: '' }] });
  assert.ok(!behaviorCardsFor(data).some((card) => card.id === 'blank'));
});

test('最近一次修改的卡片组成为新讨论默认值；明确给出的部分优先', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-behavior-defaults-'));
  try {
    assert.deepEqual(loadBehaviorDefaults(dir), { enabled: false, cards: defaultBehaviorCards().cards });
    const preset = BEHAVIOR_PRESETS.find((p) => p.id === 'claude-no-easy-agree');
    saveBehaviorDefaults(dir, { enabled: true, version: 5, cards: [{ ...preset, enabled: true }] });
    const saved = loadBehaviorDefaults(dir);
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.cards.map((card) => card.id), ['claude-no-easy-agree']);
    assert.deepEqual(inheritBehaviorCards(undefined, saved), saved);
    assert.equal(inheritBehaviorCards({ enabled: false }, saved).cards, saved.cards);
    assert.equal(inheritBehaviorCards({ enabled: false }, saved).enabled, false);
    // 重复 ID（例如同一预设加了两次）自动区分
    const ids = normalizeBehaviorCards(inheritBehaviorCards({ cards: [{ ...preset, id: 'x' }, { ...preset, id: 'x' }] }, saved)).cards.map((card) => card.id);
    assert.equal(new Set(ids).size, 2);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('重命名只改显示名，不进入模型提示；清空恢复原始议题', (t) => {
  const { room } = makeRoom(t);
  room.rename('  行为卡  ');
  assert.equal(room.summary().title, '行为卡');
  assert.equal(room.summary().topic, '工程方案');
  room.rename('');
  assert.equal(room.summary().title, undefined);
  room.rename('工程方案');
  assert.equal(room.d.title, undefined);
});

test('同一条件动作双边可见，自律和条件性追问分开；无卡时明确撤销', () => {
  const data = { models, behaviorCards: settings(), behaviorCardsSeen: { claude: '', codex: '' } };
  const own = behaviorPrompt(data, 'codex'), peer = behaviorPrompt(data, 'claude');
  assert.ok(own.includes(data.behaviorCards.cards[0].text));
  assert.ok(peer.includes(data.behaviorCards.cards[0].text));
  // 短处：对方实际看到就引用原话指出，本人被指出时核对、属实就承认；长处：本人多承担、对方主动请教
  assert.ok(own.includes('出现这种情况时照做')); assert.ok(own.includes('直接承认并改正'));
  assert.ok(peer.includes('引用原话')); assert.ok(peer.includes('没有出现就不提'));
  assert.ok(own.includes('主动多承担')); assert.ok(peer.includes('先请对方出方案'));
  assert.ok(own.includes('不代表你或对方一定有'));
  assert.ok(peer.includes('用户经验，尚未验证'));
  data.behaviorCardsSeen.codex = behaviorSignature(data);
  assert.equal(behaviorPrompt(data, 'codex'), '');
  data.behaviorCards.enabled = false;
  assert.ok(behaviorPrompt(data, 'codex').includes('停止执行和依据旧卡追问'));
});

test('新建与历史恢复保持关闭，设置版本由服务递增且保留上限更新', (t) => {
  const { room } = makeRoom(t);
  assert.equal(room.d.behaviorCards.enabled, false);
  room.updateSettings({ behaviorCards: { ...settings(), version: 200 }, maxTurns: 8 });
  assert.equal(room.d.behaviorCards.version, 1); assert.equal(room.d.maxTurns, 8);
  room.save(true);
  assert.deepEqual(Room.load(room.dir, {}).d.behaviorCards, room.d.behaviorCards);
  const old = JSON.parse(fs.readFileSync(path.join(room.dir, 'state.json'), 'utf8'));
  delete old.behaviorCards; delete old.behaviorCardsSeen;
  fs.writeFileSync(path.join(room.dir, 'state.json'), JSON.stringify(old));
  assert.equal(Room.load(room.dir, {}).d.behaviorCards.enabled, false);
});

test('独立提案卡不泄露对方输出；失败重试重新附卡，成功后不重复', async (t) => {
  const { room, claude, codex } = makeRoom(t, { behaviorCards: settings() });
  room.start();
  await waitFor(() => claude.turns.length === 1 && codex.turns.length === 1);
  claude.turns[0].finish('completed', 'CLAUDE_SECRET'); codex.turns[0].finish('failed', '');
  await waitFor(() => room.d.status === 'paused');
  assert.equal(room.d.behaviorCardsSeen.codex, '');
  room.resume(); await waitFor(() => codex.turns.length === 2);
  assert.ok(codex.prompts[1].includes('双边行为卡'));
  assert.ok(!codex.prompts[1].includes('CLAUDE_SECRET'));
  codex.turns[1].finish(); await waitFor(() => claude.turns.length === 2);
  assert.ok(!claude.prompts[1].includes('双边行为卡'));
  const recorded = room.d.messages.find((m) => m.from === 'codex' && m.status === 'failed');
  assert.equal(recorded.behaviorCards.cards[0].subject, 'codex');
  assert.equal(recorded.behaviorCards.models.codex.model, 'gpt-6-astra');
});

test('处理中停用：当次保留快照，下一轮双方收到撤销，不提前收敛；恢复保留待送状态', async (t) => {
  const ctx = makeRoom(t, { behaviorCards: settings(), maxRounds: 1 });
  const { room, claude, codex } = ctx;
  await discussion(ctx);
  room.updateSettings({ behaviorCards: { ...room.d.behaviorCards, enabled: false } });
  const oldMessage = room.d.messages.find((m) => m.from === 'claude' && m.status === 'streaming');
  assert.equal(oldMessage.behaviorCards.enabled, true);
  claude.turns[1].finish(); await waitFor(() => codex.turns.length === 2);
  assert.equal(room.d.converge.claude, false);
  assert.ok(codex.prompts[1].includes('停止执行和依据旧卡追问'));
  codex.turns[1].finish(); await waitFor(() => claude.turns.length === 3);
  assert.equal(room.d.phase, 'discussion');
  assert.ok(claude.prompts[2].includes('停止执行和依据旧卡追问'));
  room.interrupt(); await waitFor(() => !room.pumping);
  assert.notEqual(room.d.behaviorCardsSeen.claude, '');
  room.save(true);
  const restored = Room.load(room.dir, {});
  assert.ok(behaviorPrompt(restored.d, 'claude').includes('停止执行和依据旧卡追问'));
  room.resume(); await waitFor(() => claude.turns.length === 4);
  assert.ok(claude.prompts[3].includes('停止执行和依据旧卡追问'));
});

test('切换型号不重新绑定卡：下一轮撤销旧卡并清空收敛', async (t) => {
  const ctx = makeRoom(t, { behaviorCards: settings() });
  const { room, claude, codex } = ctx;
  await discussion(ctx);
  room.updateModels({ codex: { model: 'unknown', effort: 'high' } });
  assert.deepEqual(room.d.converge, { claude: false, codex: false });
  claude.turns[1].finish(); await waitFor(() => codex.turns.length === 2);
  assert.ok(codex.prompts[1].includes('之前的行为卡作废'));
  assert.ok(!codex.prompts[1].includes('保护设计是否必要'));
  assert.ok(codex.prompts[1].includes('发散之后落到可执行方向'));
  assert.deepEqual(room.d.behaviorCards.cards[0].modelIds, ['gpt-6-astra', 'gpt-6-sol']);
});

test('首次注入失败后停用：未确认卡也须在重试明确作废', async (t) => {
  const { room, claude, codex } = makeRoom(t, { behaviorCards: settings() });
  room.start(); await waitFor(() => claude.turns.length === 1 && codex.turns.length === 1);
  claude.turns[0].finish('completed', 'CLAUDE_SECRET'); codex.turns[0].finish('failed', '');
  await waitFor(() => room.d.status === 'paused');
  assert.equal(room.d.behaviorCardsSeen.codex, '');
  assert.equal(room.d.behaviorCardsDirty.codex, true);
  room.updateSettings({ behaviorCards: { ...room.d.behaviorCards, enabled: false } });
  room.resume(); await waitFor(() => codex.turns.length === 2);
  assert.ok(codex.prompts[1].includes('停止执行和依据旧卡追问'));
  assert.ok(!codex.prompts[1].includes('CLAUDE_SECRET'));
  codex.turns[1].finish(); await waitFor(() => claude.turns.length === 2);
  assert.equal(room.d.behaviorCardsDirty.codex, false);
  assert.equal(room.d.behaviorCardsSeen.codex, '');
});

test('编辑动作与停用单卡：下一轮使用当前卡，旧发言快照不改写', async (t) => {
  const ctx = makeRoom(t, { behaviorCards: settings() });
  const { room, claude, codex } = ctx;
  await discussion(ctx);
  const edited = JSON.parse(JSON.stringify(room.d.behaviorCards));
  edited.cards[0].text = '仅检查当前输入契约支持的失败路径，保留必要保护。';
  room.updateSettings({ behaviorCards: edited });
  claude.turns[1].finish(); await waitFor(() => codex.turns.length === 2);
  assert.ok(codex.prompts[1].includes(edited.cards[0].text));
  assert.ok(!room.d.messages.find((m) => m.from === 'codex' && m.phase === 'independent').behaviorCards.cards[0].text.includes(edited.cards[0].text));
  const disabled = JSON.parse(JSON.stringify(room.d.behaviorCards));
  disabled.cards[0].enabled = false;
  room.updateSettings({ behaviorCards: disabled });
  codex.turns[1].finish(); await waitFor(() => claude.turns.length === 3);
  assert.ok(claude.prompts[2].includes('发散之后落到可执行方向'));
  assert.ok(claude.prompts[2].includes('探索阶段照常发散'));
  assert.ok(!claude.prompts[2].includes(edited.cards[0].text));
  assert.equal(room.d.behaviorCards.version, 2);
});

test('旧卡的触发和动作两栏合成一句提醒；未知类型按短处处理', () => {
  const [card] = normalizeBehaviorCards({ cards: [{ id: 'old', title: '旧卡', subject: 'codex', modelIds: ['gpt-6-astra'], trigger: '提出额外保护时。', action: '说明必要性。' }] }).cards;
  assert.equal(card.text, '提出额外保护时。 说明必要性。');
  assert.equal(card.kind, 'weakness');
  assert.equal('trigger' in card, false);
});
