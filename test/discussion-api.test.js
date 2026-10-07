import { test } from 'node:test';
import assert from 'node:assert/strict';
import { experimentAction, assertDiscussionAvailable, roomResult } from '../lib/discussion-api.js';

function fixture() {
  const calls = [];
  const room = {
    d: { id: 'room', phase: 'discussion', status: 'running', messages: [] },
    speaking: new Map(),
    snapshot() { return { ...this.d, speaking: [...this.speaking.keys()] }; },
    pause() { if (this.d.status === 'running') this.d.status = 'paused'; },
    save() {}, emit() {},
    acceptExperiment(evidence, id) { calls.push(['evidence', evidence, id]); },
    experiment: {
      state: { id: 'exp', status: 'draft' },
      snapshot() { return this.state; },
      async saveCard(body) { calls.push(['card', body]); return this.state; },
      async start(body) { calls.push(['start', body]); return this.state; },
      async cancel() { calls.push(['cancel']); return this.state; },
      async returnResult(body, acceptEvidence) {
        if (body.confirmed !== true) throw new Error('需要确认');
        acceptEvidence('模型报告：不是用户指令', this.state.id);
        this.state.status = 'returned';
        return '模型报告：不是用户指令';
      },
    },
  };
  return { room, calls };
}

test('保存实验卡会暂停讨论，非法卡不改变讨论状态', async () => {
  const { room } = fixture();
  await experimentAction(room, 'card', { card: {} });
  assert.equal(room.d.status, 'paused');
  room.d.status = 'running';
  room.experiment.saveCard = async () => { throw new Error('缺少判定条件'); };
  await assert.rejects(experimentAction(room, 'card', {}), /判定条件/);
  assert.equal(room.d.status, 'running');
});

test('结束后的等待状态也能保存实验卡并进入确认暂停', async () => {
  const { room } = fixture();
  room.d.phase = 'done'; room.d.status = 'waiting';
  await experimentAction(room, 'card', {});
  assert.equal(room.d.status, 'paused');
});

test('独立提案和总结阶段不能插入实验，避免提案泄露和过期定稿', async () => {
  for (const phase of ['independent', 'summary', 'review', 'finalize']) {
    const { room } = fixture(); room.d.phase = phase;
    await assert.rejects(experimentAction(room, 'card', {}), /独立提案/);
    await assert.rejects(experimentAction(room, 'return', { confirmed: true }), /发言或总结/);
  }
});

test('明确确认才能把报告作为独立证据带回', async () => {
  const { room, calls } = fixture();
  room.experiment.state.status = 'completed';
  await assert.rejects(experimentAction(room, 'return'), /确认/);
  assert.equal(calls.length, 0);
  await experimentAction(room, 'return', { confirmed: true });
  assert.deepEqual(calls, [['evidence', '模型报告：不是用户指令', 'exp']]);
});

test('运行中的实验阻止恢复生成，但仍能停止或修改事实', () => {
  const { room } = fixture(); room.experiment.state.status = 'running';
  for (const action of ['message', 'resume', 'finish', 'finalize', 'check']) {
    assert.throws(() => assertDiscussionAvailable(room, action), /小实验正在运行/);
  }
  assert.doesNotThrow(() => assertDiscussionAvailable(room, 'stop'));
  assert.doesNotThrow(() => assertDiscussionAvailable(room, 'facts'));
});

test('正在发言时结果接口不把历史结论宣告为本次已完成', () => {
  const { room } = fixture();
  room.d.phase = 'done';
  room.d.messages = [
    { id: 's', from: 'claude', kind: 'summary', status: 'complete', text: '结论' },
    { id: 'r', from: 'codex', kind: 'review', status: 'complete', text: '【复核】无异议' },
  ];
  assert.equal(roomResult(room).ready, true);
  room.speaking.set('claude', {});
  assert.equal(roomResult(room).ready, false);
});
