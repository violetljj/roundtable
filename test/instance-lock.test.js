// 单实例锁：用假的探测和进程存活判断，不启动真实服务。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimInstance, readLock, updateInstance, releaseInstance, lockPath } from '../lib/instance-lock.js';

function dir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-lock-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const writeLock = (d, lock) => fs.writeFileSync(lockPath(d), JSON.stringify(lock));
const fast = { startupWaitMs: 60, pollMs: 10 };

test('没有别的服务时取得锁，启动后记下端口，退出时只删自己的锁', async (t) => {
  const d = dir(t);
  assert.equal(await claimInstance(d, { basePort: 4545, probe: async () => false, ...fast }), null);
  assert.equal(readLock(d).pid, process.pid);
  updateInstance(d, { port: 4547 });
  assert.equal(readLock(d).port, 4547);
  releaseInstance(d);
  assert.equal(readLock(d), null);
  writeLock(d, { pid: process.pid + 1, port: 4545, startedAt: 1 });
  releaseInstance(d);
  assert.equal(readLock(d).pid, process.pid + 1, '别人的锁不能删');
});

test('已有服务在顺延端口上运行：返回它的端口，不改锁文件', async (t) => {
  const d = dir(t);
  writeLock(d, { pid: 999999, port: 4546, startedAt: 1 });
  const got = await claimInstance(d, { basePort: 4545, alive: () => true, probe: async (p) => p === 4546, ...fast });
  assert.deepEqual(got, { port: 4546 });
  assert.equal(readLock(d).pid, 999999);
});

test('对方刚启动还没写端口：等它开始监听再打开它', async (t) => {
  const d = dir(t);
  writeLock(d, { pid: 999999, port: null, startedAt: 1 });
  setTimeout(() => writeLock(d, { pid: 999999, port: 4545, startedAt: 1 }), 25);
  const got = await claimInstance(d, { basePort: 4545, alive: () => true, probe: async (p) => p === 4545, startupWaitMs: 500, pollMs: 10 });
  assert.deepEqual(got, { port: 4545 });
});

test('占用者进程已经不在，或 PID 被别的程序复用（一直不应答）：接管锁', async (t) => {
  for (const alive of [() => false, () => true]) {
    const d = dir(t);
    writeLock(d, { pid: 999999, port: 4545, startedAt: 1 });
    assert.equal(await claimInstance(d, { basePort: 4545, alive, probe: async () => false, ...fast }), null);
    assert.equal(readLock(d).pid, process.pid);
  }
});

test('没有锁文件的旧版服务：在顺延范围内找到它', async (t) => {
  const d = dir(t);
  const got = await claimInstance(d, { basePort: 4545, probe: async (p) => p === 4548, ...fast });
  assert.deepEqual(got, { port: 4548 });
  assert.equal(readLock(d), null);
});
