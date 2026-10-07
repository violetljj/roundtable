import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderQueue } from '../public/render-queue.js';

function fakeFrames() {
  let nextId = 0;
  let requests = 0;
  const callbacks = new Map();
  const cancelled = [];
  return {
    callbacks,
    cancelled,
    get requests() { return requests; },
    requestFrame(callback) { requests++; const id = nextId++; callbacks.set(id, callback); return id; },
    cancelFrame(id) { cancelled.push(id); callbacks.delete(id); },
    tick() {
      const batch = [...callbacks.values()];
      callbacks.clear();
      for (const callback of batch) callback();
    },
  };
}

function setup(render) {
  const frames = fakeFrames();
  const batches = [];
  const queue = createRenderQueue({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    render: render ?? ((batch) => batches.push(batch)),
  });
  return { frames, batches, queue };
}

test('同一消息 100 次增量只安排一个帧并渲染最终文本', () => {
  const { frames, batches, queue } = setup();
  const message = { id: 'one', text: '' };
  for (let i = 0; i < 100; i++) { message.text += '字'; queue.enqueue(message); }
  assert.equal(frames.requests, 1);
  assert.equal(batches.length, 0);
  frames.tick();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 1);
  assert.equal(batches[0][0].text.length, 100);
  queue.enqueue(message);
  frames.tick();
  assert.equal(frames.requests, 2);
  assert.equal(batches.length, 2);
});

test('双路消息同帧合并，同 ID 的替换对象取最新值', () => {
  const { frames, batches, queue } = setup();
  queue.enqueue({ id: 'claude', text: '旧' });
  queue.enqueue({ id: 'codex', text: '另一方' });
  queue.enqueue({ id: 'claude', text: '新' });
  assert.equal(frames.requests, 1);
  frames.tick();
  assert.deepEqual(batches, [[{ id: 'claude', text: '新' }, { id: 'codex', text: '另一方' }]]);
});

test('切换房间或接收快照后 clear 取消旧帧，并忽略取消后迟到的回调', () => {
  const { frames, batches, queue } = setup();
  queue.enqueue({ id: 'same', room: 'old' });
  const lateCallback = frames.callbacks.get(0);
  queue.clear();
  assert.deepEqual(frames.cancelled, [0]);
  queue.enqueue({ id: 'same', room: 'new' });
  lateCallback();
  assert.equal(batches.length, 0);
  assert.equal(frames.callbacks.size, 1);
  frames.tick();
  assert.deepEqual(batches, [[{ id: 'same', room: 'new' }]]);
});

test('渲染中到达的新消息留到下一帧，不扩展当前批次', () => {
  const seen = [];
  let queue;
  const setupResult = setup((batch) => {
    seen.push(batch.map((message) => message.id));
    if (seen.length === 1) queue.enqueue({ id: 'next' });
  });
  queue = setupResult.queue;
  queue.enqueue({ id: 'current' });
  setupResult.frames.tick();
  assert.deepEqual(seen, [['current']]);
  assert.equal(setupResult.frames.callbacks.size, 1);
  setupResult.frames.tick();
  assert.deepEqual(seen, [['current'], ['next']]);
});

test('渲染异常不锁死之后的帧，空 clear 可重复调用', () => {
  let calls = 0;
  const { frames, queue } = setup(() => { if (++calls === 1) throw new Error('模拟渲染失败'); });
  queue.clear();
  queue.clear();
  assert.deepEqual(frames.cancelled, []);
  queue.enqueue({ id: 'one' });
  assert.throws(() => frames.tick(), /模拟渲染失败/);
  queue.enqueue({ id: 'two' });
  frames.tick();
  assert.equal(calls, 2);
});
