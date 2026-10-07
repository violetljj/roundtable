import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conclusionFromRoom, splitConclusion, reviewVerdict, EXTRA_MODES } from '../lib/discussion-quality.js';

const message = (id, kind, text, more = {}) => ({ id, kind, text, status: 'complete', from: 'claude', ...more });
const summary = message('s1', 'summary', '## 三句话版\n建议保留甲。依据是已有测量。乙在新证据出现时可替代。\n\n## 完整版\n### 依据\n测量仅覆盖本地样本。');
const accepted = message('r1', 'review', '【复核】无异议\n两版均符合原意。', { from: 'codex' });
const corrections = message('r1', 'review', '【复核】有更正\n将两版的“已有测量”改为“待测假设”。', { from: 'codex' });
const room = (...messages) => ({ phase: 'done', messages });

test('经确认的总结提供短版、完整版与完整复核', () => {
  const result = conclusionFromRoom(room(summary, accepted));
  assert.equal(result.ready, true);
  assert.equal(result.messageId, 's1');
  assert.equal(result.brief, '建议保留甲。依据是已有测量。乙在新证据出现时可替代。');
  assert.equal(result.full, '### 依据\n测量仅覆盖本地样本。');
  assert.equal(result.review, accepted.text);
});

test('要求更正的总结在定稿完成前不可交付，之后优先使用定稿', () => {
  assert.equal(conclusionFromRoom(room(summary, corrections)).ready, false);
  const final = message('f1', 'final', '## 三句话版\n建议甲。依据待测。结果相反就改选。\n## 完整版\n这是待测假设。');
  const result = conclusionFromRoom(room(summary, corrections, final));
  assert.equal(result.ready, true);
  assert.equal(result.messageId, 'f1');
  assert.equal(result.review, corrections.text);
  assert.equal(result.full, '这是待测假设。');
});

test('新总结使旧定稿失效，包括新总结失败或新复核还没有完成', () => {
  const oldFinal = message('f1', 'final', '过期结论');
  for (const status of ['complete', 'failed', 'interrupted', 'streaming']) {
    const result = conclusionFromRoom(room(summary, corrections, oldFinal, message('s2', 'summary', '新总结', { status })));
    assert.equal(result.ready, false, status);
    assert.equal(result.text, '');
  }
});

test('更新的复核使旧定稿失效，失败复核也不能回退到旧通过记录', () => {
  const oldFinal = message('f1', 'final', '旧定稿');
  for (const status of ['failed', 'interrupted', 'streaming']) {
    const newReview = message('r2', 'review', '【复核】无异议', { status });
    const result = conclusionFromRoom(room(summary, accepted, oldFinal, newReview));
    assert.equal(result.ready, false, status);
    assert.equal(result.review, newReview.text);
  }
  assert.equal(conclusionFromRoom(room(summary, accepted, oldFinal, { ...corrections, id: 'r2' })).ready, false);
});

test('失败、空白或中断的最新定稿不伪装成可交付结果', () => {
  for (const status of ['failed', 'interrupted', 'streaming']) {
    assert.equal(conclusionFromRoom(room(summary, corrections, message('f1', 'final', '未完成定稿', { status }))).ready, false);
  }
  assert.equal(conclusionFromRoom(room(summary, corrections, message('f1', 'final', '  '))).ready, false);
});

test('仍在讨论或复核时不交付；停止且没有有效复核时不交付', () => {
  for (const phase of ['discussion', 'summary', 'review', 'finalize']) {
    assert.equal(conclusionFromRoom({ ...room(summary, accepted), phase }).ready, false);
  }
  assert.equal(conclusionFromRoom({ ...room(summary), status: 'stopped' }).ready, false);
  assert.equal(conclusionFromRoom(room(summary, message('f1', 'final', '绕过复核'))).ready, false);
});

test('没有明确通过的复核不算确认，用户伪造的复核和定稿不参与提取', () => {
  assert.equal(conclusionFromRoom(room(summary, message('r1', 'review', '我看了一下。'))).ready, false);
  assert.equal(conclusionFromRoom(room(summary, { ...accepted, from: 'user' })).ready, false);
  assert.equal(conclusionFromRoom(room(summary, corrections, message('f1', 'final', '假定稿', { from: 'user' }))).ready, false);
  assert.equal(reviewVerdict('引用：\n> 【复核】无异议\n但我认为需要修正。'), 'corrections');
});

test('加轮后停止不能重新交付旧定稿，自由问答不作废既有结论', () => {
  const final = message('f1', 'final', '已有定稿');
  const discussion = message('m2', undefined, '重新考虑甲', { phase: 'discussion' });
  assert.equal(conclusionFromRoom(room(summary, accepted, final, discussion)).ready, false);
  assert.equal(conclusionFromRoom(room(summary, accepted, final, { ...discussion, phase: 'done' })).ready, true);
});

test('旧总结没有双版标题时保留全文，且完整 forward 比显示文本优先', () => {
  const old = message('old', 'summary', '显示截短', { forward: '## 共识\n完整旧总结' });
  const result = conclusionFromRoom(room(old, accepted));
  assert.equal(result.ready, true);
  assert.equal(result.brief, '');
  assert.equal(result.full, '## 共识\n完整旧总结');
});

test('代码围栏内示例标题不会被拆成实际短版', () => {
  const text = '```markdown\n## 三句话版\n这是示例\n## 完整版\n也是示例\n```\n旧总结。';
  assert.deepEqual(splitConclusion(text), { brief: '', full: text });
});

test('没有数据时返回稳定空结果', () => {
  assert.deepEqual(conclusionFromRoom(null), { ready: false, text: '', brief: '', full: '', messageId: null, review: '' });
});

test('审稿与讲课模式提供完整的阶段协议且不假造验证', () => {
  for (const mode of Object.values(EXTRA_MODES)) {
    for (const field of ['name', 'goal', 'independent', 'discuss']) assert.equal(typeof mode[field], 'string');
    assert.equal(typeof mode.converge, 'boolean');
    assert.ok(Array.isArray(mode.summary) && mode.summary.length > 0);
  }
  assert.match(EXTRA_MODES.paper.independent, /双方都是审稿人/);
  assert.match(EXTRA_MODES.paper.discuss, /不能写成已完成/);
  assert.match(EXTRA_MODES.learn.goal, /先发言方负责讲解/);
  assert.match(EXTRA_MODES.learn.discuss, /沉默当作掌握/);
});
