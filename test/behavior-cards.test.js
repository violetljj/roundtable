// 检查实际送入的提示与调度状态，不把模拟流程当作真实模型行为改善。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room } from '../lib/room.js';
import { defaultBehaviorCards, normalizeBehaviorCards, behaviorCardsFor, behaviorSignature, behaviorPrompt } from '../lib/behavior-cards.js';

const models = { codex: { model: 'gpt-6-astra', effort: 'high' }, claude: { model: 'claude-opus-5-5', effort: 'high' } };
function settings(scene = 'engineering') { return { ...defaultBehaviorCards(models), enabled: true, scene }; }
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

test('默认关闭；场景和具体型号精确匹配，不推断未知型号倾向', () => {
  const data = { models, behaviorCards: defaultBehaviorCards(models) };
  assert.deepEqual(behaviorCardsFor(data), []);
  assert.equal(behaviorPrompt(data, 'codex'), '');
  data.behaviorCards = settings();
  assert.equal(behaviorCardsFor(data)[0].subject, 'codex');
  data.models = { ...models, codex: { model: 'gpt-6-astra-next' } };
  assert.deepEqual(behaviorCardsFor(data), []);
  data.models = { ...models, codex: { model: '' } };
  assert.deepEqual(behaviorCardsFor(data), []);
  data.behaviorCards = settings('creative');
  data.models = { ...models, claude: { model: 'opus' } };
  assert.deepEqual(behaviorCardsFor(data), []);
  assert.deepEqual(defaultBehaviorCards({ claude: { model: 'haiku' } }).cards[1].modelIds, ['claude-opus-5-5']);
  data.models = models;
  assert.equal(behaviorCardsFor(data)[0].subject, 'claude');
  data.behaviorCards.scene = 'general';
  assert.deepEqual(behaviorCardsFor(data), []);
  const edited = settings();
  edited.cards[0].modelIds = ['custom-model'];
  data.behaviorCards = normalizeBehaviorCards(edited, models);
  data.models = { ...models, codex: { model: 'custom-model' } };
  assert.equal(behaviorCardsFor(data).length, 1);
});

test('同一条件动作双边可见，自律和条件性追问分开；无卡时明确撤销', () => {
  const data = { models, behaviorCards: settings(), behaviorCardsSeen: { claude: '', codex: '' } };
  const own = behaviorPrompt(data, 'codex'), peer = behaviorPrompt(data, 'claude');
  assert.ok(own.includes(data.behaviorCards.cards[0].action));
  assert.ok(peer.includes(data.behaviorCards.cards[0].action));
  assert.ok(own.includes('触发时执行')); assert.ok(peer.includes('条件性追问'));
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
  assert.ok(codex.prompts[1].includes('当前无生效行为卡'));
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

test('编辑动作与切换场景：下一轮使用当前卡，旧发言快照不改写', async (t) => {
  const ctx = makeRoom(t, { behaviorCards: settings() });
  const { room, claude, codex } = ctx;
  await discussion(ctx);
  const edited = JSON.parse(JSON.stringify(room.d.behaviorCards));
  edited.cards[0].action = '仅检查当前输入契约支持的失败路径，保留必要保护。';
  room.updateSettings({ behaviorCards: edited });
  claude.turns[1].finish(); await waitFor(() => codex.turns.length === 2);
  assert.ok(codex.prompts[1].includes(edited.cards[0].action));
  assert.ok(!room.d.messages.find((m) => m.from === 'codex' && m.phase === 'independent').behaviorCards.cards[0].action.includes(edited.cards[0].action));
  room.updateSettings({ behaviorCards: { ...room.d.behaviorCards, scene: 'creative' } });
  codex.turns[1].finish(); await waitFor(() => claude.turns.length === 3);
  assert.ok(claude.prompts[2].includes('创意探索与可执行方向'));
  assert.ok(claude.prompts[2].includes('探索阶段保留新机制和未验证方向'));
  assert.ok(!claude.prompts[2].includes(edited.cards[0].action));
  assert.equal(room.d.behaviorCards.version, 2);
});
