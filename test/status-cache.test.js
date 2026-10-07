import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatusCache } from '../lib/status-cache.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('首次查询立即返回读取中，并发访问只启动一次慢查询', async () => {
  const gate = deferred();
  let calls = 0;
  const cache = createStatusCache({ load: () => { calls++; return gate.promise; }, ttlMs: 60000, now: () => 10 });
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(cache.read(), { value: null, updatedAt: null, error: null, refreshing: true });
  }
  const pending = cache.refresh(true);
  await Promise.resolve();
  assert.equal(calls, 1);
  gate.resolve({ loggedIn: true });
  await pending;
  assert.deepEqual(cache.read(), { value: { loggedIn: true }, updatedAt: 10, error: null, refreshing: false });
});

test('过期缓存立即返回，后台完成才替换，并从完成时计算有效期', async () => {
  let time = 0, calls = 0;
  const gate = deferred();
  const observed = [];
  const cache = createStatusCache({
    load: () => ++calls === 1 ? 'old' : gate.promise,
    onValue: (value) => observed.push(value), ttlMs: 100, now: () => time,
  });
  await cache.refresh();
  time = 99;
  assert.equal(cache.read().refreshing, false);
  time = 100;
  assert.deepEqual(cache.read(), { value: 'old', updatedAt: 0, error: null, refreshing: true });
  const pending = cache.refresh();
  time = 500;
  gate.resolve('new');
  await pending;
  time = 599;
  assert.deepEqual(cache.read(), { value: 'new', updatedAt: 500, error: null, refreshing: false });
  assert.deepEqual(observed, ['old', 'new']);
  assert.equal(calls, 2);
});

test('失败保留旧值、退避并允许手动重试，成功后清除错误', async () => {
  let time = 0, fail = false, calls = 0;
  const cache = createStatusCache({
    load: () => { calls++; if (fail) throw new Error('暂不可用'); return calls; },
    ttlMs: 100, retryMs: 20, now: () => time,
  });
  await cache.refresh();
  fail = true;
  time = 100;
  await cache.refresh();
  assert.deepEqual(cache.read(), { value: 1, updatedAt: 0, error: '暂不可用', refreshing: false });
  time = 119;
  await cache.refresh();
  assert.equal(calls, 2);
  fail = false;
  await cache.refresh(true);
  assert.deepEqual(cache.read(), { value: 3, updatedAt: 119, error: null, refreshing: false });
});

test('首次失败不会伪装成已读取，退避结束只重试一次', async () => {
  let time = 0, calls = 0;
  const cache = createStatusCache({ load: () => { calls++; return Promise.reject(new Error('离线')); }, ttlMs: 100, retryMs: 20, now: () => time });
  await cache.refresh();
  assert.deepEqual(cache.read(), { value: null, updatedAt: null, error: '离线', refreshing: false });
  time = 20;
  for (let i = 0; i < 20; i++) cache.read();
  await cache.refresh();
  assert.equal(calls, 2);
});
