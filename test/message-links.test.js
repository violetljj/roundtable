import test from 'node:test';
import assert from 'node:assert/strict';
import { indexMessageLinks, experimentSeed } from '../public/message-links.js';

test('核查只回挂明确答复批次，不把邻近发言、失败或实验重新判断算核查', () => {
  const messages = [
    { id: 'q', from: 'user', target: 'codex', relatedMessageId: 'source' },
    { id: 'next', from: 'codex', status: 'complete' },
    { id: 'failed', from: 'codex', status: 'failed', responseToMessageIds: ['q'] },
    { id: 'reply', from: 'codex', status: 'complete', responseToMessageIds: ['q'] },
    { id: 'author', from: 'claude', status: 'complete', responseToMessageIds: ['q'] },
    { id: 'return', from: 'user', relatedMessageId: 'source', experimentId: 'xp' },
    { id: 'assessment', from: 'claude', status: 'complete', responseToMessageIds: ['return'] },
  ];
  const links = indexMessageLinks(messages, { id: 'xp', sourceMessageId: 'source', status: 'returned', history: [{ id: 'old', sourceMessageId: 'other', status: 'failed' }] });
  assert.deepEqual(links.get('source').checks[0].responses.map((r) => r.id), ['reply']);
  assert.deepEqual(links.get('source').assessments.map((r) => r.id), ['assessment']);
  assert.equal(links.get('other').experiments[0].status, 'failed');
  assert.equal(indexMessageLinks([], null).size, 0);
});

test('只从明确实验字段预填判据步骤，普通建议不捏造判据', () => {
  const seed = experimentSeed('实验建议\n【分歧问题】接口是否等待查询\n【判据】首个响应少于一秒\n【实验步骤】模拟延迟并测首个响应');
  assert.equal(seed.suggested, true);
  assert.equal(seed.card.decisionRule, '首个响应少于一秒');
  assert.equal(seed.card.procedure, '模拟延迟并测首个响应');
  const ordinary = experimentSeed('可以再做一个实验看看', '需要核对的选文');
  assert.equal(ordinary.suggested, false);
  assert.deepEqual(ordinary.card, { question: '需要核对的选文', decisionRule: '', procedure: '' });
  assert.equal(experimentSeed('实验尚不成熟\n判据不足\n实验步骤可能太长').suggested, false);
  assert.equal(experimentSeed('实验建议\n**判据：** 少于一秒\n**实验步骤**：模拟延迟').suggested, true);
});
