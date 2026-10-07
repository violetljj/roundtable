// 不调用真实模型的模拟测试：node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Room, reviewHasCorrections } from '../lib/room.js';
import { CodexAgent } from '../lib/codex.js';

// 模拟参与者：按脚本依次返回结果，记录收到的每条提示
function fakeAgent(name, script) {
  return {
    name, prompts: [], busy: false, pendingInterrupt: null,
    async send(prompt, cb) {
      this.prompts.push(prompt);
      const step = script.shift() ?? { text: `${name} 默认回答\n【状态】继续` };
      if (step.hang) {
        // 一直说下去，直到被打断
        return new Promise((resolve) => { this.pendingInterrupt = () => resolve({ status: 'interrupted', text: '' }); cb.onDelta?.('说到一半'); });
      }
      await new Promise((r) => setTimeout(r, 5));
      if (step.fail) return { status: 'failed', text: '', error: step.fail };
      cb.onDelta?.(step.text);
      return { status: 'completed', text: step.text };
    },
    interrupt() { this.pendingInterrupt?.(); this.pendingInterrupt = null; },
    steer: async () => false,
  };
}

function makeRoom(agents, opts = {}, ctx = {}) {
  const roomsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-test-'));
  return Room.create({ topic: '测试主题', maxRounds: 1, ...opts }, { roomsDir, agentFactory: () => agents, ...ctx });
}

test('复核结论识别', () => {
  assert.equal(reviewHasCorrections('【复核】无异议\n最重要的是先冻结参数。'), false);
  assert.equal(reviewHasCorrections('【复核】有更正\n1. 我没有建议登记 ToF 任务。'), true);
  assert.equal(reviewHasCorrections('无异议。'), false);
  assert.equal(reviewHasCorrections('有两点需要更正：\n1. 我不主张……'), true);
});

test('复核有更正：自动合并定稿，由额度更宽裕的一方来写', async () => {
  // Claude 先发言，所以最后发言的是 Codex，总结由 Claude 写、Codex 复核
  const claude = fakeAgent('claude', [
    { text: 'C0\n【状态】可以收敛' }, { text: 'C1\n【状态】可以收敛' },
    { text: '## 共识\n- 先做 A\n## 仍有分歧\n- Codex 主张登记 ToF' },
  ]);
  const codex = fakeAgent('codex', [
    { text: 'X0\n【状态】可以收敛' }, { text: 'X1\n【状态】可以收敛' },
    { text: '【复核】有更正\n1. 我没有主张登记 ToF。' },
    { text: '## 共识\n- 先做 A\n## 仍有分歧\n- 无' },
  ]);
  const room = makeRoom({ claude, codex }, {}, { pickFinalizer: () => 'codex' });
  room.start();
  await waitFor(() => room.d.phase === 'done' && !room.speaking.size, 5000);
  const final = room.d.messages.find((m) => m.kind === 'final');
  assert.ok(final, '应该生成定稿');
  assert.equal(final.from, 'codex');
  const prompt = codex.prompts.at(-1);
  assert.ok(prompt.includes('【阶段】定稿') && prompt.includes('Codex 主张登记 ToF') && prompt.includes('我没有主张登记 ToF'));
  room.stop();
});

test('复核无异议：不额外调用模型', async () => {
  const claude = fakeAgent('claude', [
    { text: 'C0\n【状态】可以收敛' }, { text: 'C1\n【状态】可以收敛' }, { text: '## 共识\n- 先做 A' },
  ]);
  const codex = fakeAgent('codex', [
    { text: 'X0\n【状态】可以收敛' }, { text: 'X1\n【状态】可以收敛' }, { text: '【复核】无异议\n记得冻结参数。' },
  ]);
  const room = makeRoom({ claude, codex });
  room.start();
  await waitFor(() => room.d.phase === 'done' && !room.speaking.size, 5000);
  assert.equal(room.d.messages.some((m) => m.kind === 'final'), false);
  assert.equal(claude.prompts.length + codex.prompts.length, 6);
  room.stop();
});

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('独立提案有一方失败：停在独立阶段，重试时只重做失败的一方，且看不到对方方案', async () => {
  const claude = fakeAgent('claude', [{ text: 'CLAUDE_PROPOSAL 秘密方案\n【状态】继续' }]);
  const codex = fakeAgent('codex', [{ fail: '网络错误' }, { text: 'Codex 方案\n【状态】继续' }]);
  const room = makeRoom({ claude, codex });
  room.start();
  await waitFor(() => room.d.status === 'paused');
  assert.equal(room.d.phase, 'independent');
  assert.deepEqual(room.d.independentDone, { claude: true, codex: false });

  room.resume();
  await waitFor(() => room.d.phase !== 'independent');
  assert.equal(claude.prompts.length >= 1, true);
  // Codex 的第二次独立提案里不能出现 Claude 的方案
  assert.equal(codex.prompts[1].includes('CLAUDE_PROPOSAL'), false);
  // Claude 的独立提案没有被重做
  assert.equal(claude.prompts.filter((p) => p.includes('【阶段】独立提案')).length, 1);
  room.stop();
});

test('独立提案被用户打断：不进入交叉讨论', async () => {
  const claude = fakeAgent('claude', [{ text: 'A\n【状态】继续' }]);
  const codex = fakeAgent('codex', [{ hang: true }]);
  const room = makeRoom({ claude, codex });
  room.start();
  await waitFor(() => claude.prompts.length === 1 && codex.pendingInterrupt);
  await new Promise((r) => setTimeout(r, 20));
  room.interrupt();
  await waitFor(() => !room.speaking.size);
  assert.equal(room.d.phase, 'independent');
  assert.equal(room.d.status, 'paused');
  room.stop();
});

test('Codex 在启动/恢复会话期间被停止：不会再开始生成', async () => {
  const calls = [];
  let release;
  const server = {
    threads: new Map(),
    start: () => new Promise((r) => { release = r; }), // 模拟慢启动
    request: async (method) => {
      calls.push(method);
      if (method === 'thread/start') return { thread: { id: 't1' }, model: 'm', reasoningEffort: 'low' };
      if (method === 'turn/start') return { turn: { id: 'turn1' } };
      return {};
    },
  };
  const agent = new CodexAgent(server, { cwd: '.', instructions: '' });
  const p = agent.send('你好');
  await new Promise((r) => setTimeout(r, 10));
  agent.interrupt(); // 用户在初始化期间点了停止
  release();
  const r = await p;
  assert.equal(r.status, 'interrupted');
  assert.equal(calls.includes('turn/start'), false);
});

test('Codex 对话被桌面端占用：自动复制一份继续，并提示用户', async () => {
  const calls = [];
  const server = {
    threads: new Map(),
    start: async () => {},
    request: async (method, params) => {
      calls.push(method);
      if (method === 'thread/resume') throw new Error(`thread/resume: thread ${params.threadId} already has an active writer`);
      if (method === 'thread/fork') return { thread: { id: 'forked-1' }, model: 'm' };
      if (method === 'turn/start') {
        setTimeout(() => server.threads.get('forked-1')('turn/completed', { turn: { status: 'completed', error: null } }), 5);
        return { turn: { id: 'turn1' } };
      }
      return {};
    },
  };
  const notices = [];
  const agent = new CodexAgent(server, { cwd: '.', instructions: '', threadId: 'locked-1', name: '圆桌：测试' });
  agent.onNotice = (t) => notices.push(t);
  const r = await agent.send('你好');
  assert.equal(r.status, 'completed');
  assert.equal(agent.threadId, 'forked-1');
  assert.deepEqual(calls.slice(0, 3), ['thread/resume', 'thread/fork', 'thread/name/set']);
  assert.equal(notices.length, 1);
});

test('约束卡：每次发言都附上；修改后双方收到"旧版本作废"和新旧两版', async () => {
  const claude = fakeAgent('claude', []);
  const codex = fakeAgent('codex', []);
  const room = makeRoom({ claude, codex }, { background: '只用现有数据', maxRounds: 3 });
  room.start();
  await waitFor(() => room.d.phase === 'discussion' && claude.prompts.length >= 1 && codex.prompts.length >= 1);
  assert.ok(claude.prompts[0].includes('【约束与事实卡 v1】') && claude.prompts[0].includes('只用现有数据'));
  room.pause();
  await waitFor(() => !room.speaking.size);
  room.updateFacts('只用现有数据；一个人两周内完成');
  const n = claude.prompts.length;
  room.resume();
  await waitFor(() => claude.prompts.length > n);
  const p = claude.prompts[n];
  assert.ok(p.includes('v1 → v2，旧版本作废') && p.includes('只用现有数据\n') && p.includes('一个人两周内完成'));
  await waitFor(() => claude.prompts.length > n + 1, 5000);
  assert.ok(claude.prompts[n + 1].includes('【约束与事实卡 v2】') && !claude.prompts[n + 1].includes('作废'));
  room.stop();
});

test('发言上限：达到后暂停在讨论阶段，调高后可以继续', async () => {
  const claude = fakeAgent('claude', []);
  const codex = fakeAgent('codex', []);
  const room = makeRoom({ claude, codex }, { maxTurns: 2, maxRounds: 3 });
  room.start();
  await waitFor(() => room.d.status === 'paused');
  assert.equal(room.d.phase, 'discussion');
  assert.equal(room.d.capHit, true);
  assert.equal(claude.prompts.length + codex.prompts.length, 2);
  room.updateSettings({ maxTurns: 3 });
  room.resume();
  await waitFor(() => room.d.status === 'paused' && claude.prompts.length + codex.prompts.length === 3);
  room.stop();
});

test('探索想法模式：不因为"可以收敛"提前结束，讨论到设定轮数', async () => {
  const say = (t) => ({ text: `${t}\n【状态】可以收敛` });
  const claude = fakeAgent('claude', [say('C0'), say('C1'), say('C2'), { text: '## 想法清单' }]);
  const codex = fakeAgent('codex', [say('X0'), say('X1'), say('X2'), { text: '【复核】无异议' }]);
  const room = makeRoom({ claude, codex }, { mode: 'brainstorm', maxRounds: 2 });
  room.start();
  await waitFor(() => room.d.phase === 'done' && !room.speaking.size, 5000);
  const discussion = room.d.messages.filter((m) => m.phase === 'discussion' && m.from !== 'system' && m.from !== 'user');
  assert.equal(discussion.length, 4); // 2 轮 × 2 人
  assert.ok(claude.prompts[0].includes('探索想法') && claude.prompts[0].includes('2–3 个彼此差异明显的思路'));
  assert.ok(room.d.messages.find((m) => m.kind === 'summary') && claude.prompts.concat(codex.prompts).some((p) => p.includes('## 想法清单')));
  room.stop();
});

test('插话送达状态：送达后标"已送达"，对方说完一轮后标"已回应"', async () => {
  const claude = fakeAgent('claude', []);
  const codex = fakeAgent('codex', [{ hang: true }]);
  const room = makeRoom({ claude, codex }, { maxRounds: 3 });
  room.start();
  await waitFor(() => codex.pendingInterrupt);
  room.userMessage('请考虑成本');
  const msg = room.d.messages.find((m) => m.from === 'user');
  assert.deepEqual([msg.seenBy.claude, msg.seenBy.codex], [false, false]);
  codex.interrupt(); // Codex 的独立提案没说完：讨论室会停在独立阶段等待重做
  await waitFor(() => room.d.status === 'paused');
  room.resume(); // 重做 Codex 的提案（这次带上插话），之后进入交叉讨论，Claude 也会收到
  await waitFor(() => msg.answeredBy?.claude && msg.answeredBy?.codex, 5000);
  assert.equal(msg.seenBy.claude && msg.seenBy.codex, true);
  room.stop();
});

test('还有未读的用户插话时不提前收敛', async () => {
  const claude = fakeAgent('claude', [
    { text: 'C0\n【状态】可以收敛' }, { text: 'C1\n【状态】可以收敛' }, { text: 'C2\n【状态】可以收敛' },
  ]);
  const codex = fakeAgent('codex', [{ text: 'X0\n【状态】可以收敛' }]);
  const room = makeRoom({ claude, codex }, { maxRounds: 3 });
  // Codex 第一轮交叉讨论时，用户插话
  const origSend = codex.send.bind(codex);
  let injected = false;
  codex.send = async (prompt, cb) => {
    if (prompt.includes('交叉讨论') && !injected) { injected = true; room.userMessage('请再考虑成本'); }
    return origSend(prompt, cb);
  };
  room.start();
  await waitFor(() => ['summary', 'review', 'done'].includes(room.d.phase), 5000);
  // 用户插话之后，Claude 至少又发言了一次（看到了插话）才进入总结
  const sawUser = claude.prompts.some((p) => p.includes('请再考虑成本') && p.includes('交叉讨论'));
  assert.equal(sawUser, true);
  room.stop();
});
