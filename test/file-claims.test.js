import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FileClaims } from '../lib/file-claims.js';

const cli = fileURLToPath(new URL('../scripts/claims.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-claims-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'hello\n');
  git(repo, 'add', 'hello.txt'); git(repo, 'commit', '-m', 'Initial');
  return { root, repo, store: new FileClaims(repo) };
}
function run(repo, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--repo', repo], { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('中文批量认领、续期和释放；凭据不出现在列表', async (t) => {
  const { store, repo } = fixture(t);
  const result = await store.claim({ files: ['docs/说明.md', 'hello.txt'], owner: 'Codex', task: '更新说明', ttlMinutes: 30 });
  assert.equal(result.claims.length, 2);
  const listed = await store.list();
  assert.equal(listed[0].task, '更新说明'); assert.equal(listed[0].stale, false);
  assert.ok(!('token' in listed[0]));
  await store.renew({ files: ['hello.txt'], owner: 'Codex', token: result.token, ttlMinutes: 90 });
  assert.ok(Date.parse((await store.list())[1].expiresAt) > Date.parse(result.claims[1].expiresAt));
  await store.release({ files: ['docs/说明.md', 'hello.txt'], owner: 'Codex', token: result.token });
  assert.deepEqual(await store.list(), []);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(fs.existsSync(store.lock), false);
});

test('批量冲突不留下部分认领，且不能以持有者名称代替凭据', async (t) => {
  const { store } = fixture(t);
  const original = await store.claim({ files: ['hello.txt'], owner: 'Claude', task: '现有任务' });
  await assert.rejects(store.claim({ files: ['new.txt', 'hello.txt'], owner: 'Codex', task: '新任务' }), { code: 'CLAIM_CONFLICT' });
  assert.deepEqual((await store.list()).map((row) => row.file), ['hello.txt']);
  await assert.rejects(store.release({ files: ['hello.txt'], owner: 'Claude', token: 'wrong' }), { code: 'NOT_OWNER' });
  await assert.rejects(store.renew({ files: ['hello.txt'], owner: 'Codex', token: original.token }), { code: 'NOT_OWNER' });
  await assert.rejects(store.release({ files: ['hello.txt', 'unknown.txt'], owner: 'Claude', token: original.token }), { code: 'NOT_OWNER' });
  assert.equal((await store.list()).length, 1);
});

test('到期只显示失联，不允许抢占；原持有者仍能续期', async (t) => {
  const { store } = fixture(t);
  const result = await store.claim({ files: ['hello.txt'], owner: 'Claude', task: '短任务', ttlMinutes: 0.00001 });
  await delay(10);
  assert.equal((await store.list())[0].stale, true);
  await assert.rejects(store.claim({ files: ['hello.txt'], owner: 'Codex', task: '不能抢占' }), { code: 'CLAIM_CONFLICT' });
  await store.renew({ files: ['hello.txt'], owner: 'Claude', token: result.token });
  assert.equal((await store.list())[0].stale, false);
});

test('拒绝逃逸、别名和链接；相同文件路径规范化', async (t) => {
  const { store, root, repo } = fixture(t);
  for (const file of ['../outside.txt', 'docs/../../outside.txt', 'C:\\outside.txt', '/outside.txt', '.git/config', 'docs/x.', 'docs/x ', 'NUL.txt', 'hello.txt:stream']) {
    assert.throws(() => store.claim({ files: [file], owner: 'Codex', task: '非法' }), { code: 'UNSAFE_PATH' }, file);
  }
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const link = path.join(repo, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.claim({ files: ['linked/file.txt'], owner: 'Codex', task: '逃逸' }), { code: 'UNSAFE_PATH' });
  fs.unlinkSync(link);
  await store.claim({ files: ['./docs/说明.md'], owner: 'Codex', task: '相对路径' });
  await assert.rejects(store.claim({ files: ['docs\\说明.md'], owner: 'Claude', task: '同一个文件' }), { code: 'CLAIM_CONFLICT' });
  if (process.platform === 'win32') {
    await store.claim({ files: ['HELLO.TXT'], owner: 'Codex', task: '大小写' });
    await assert.rejects(store.claim({ files: ['hello.txt'], owner: 'Claude', task: '同一个文件' }), { code: 'CLAIM_CONFLICT' });
  }
});

test('不同进程同时认领只有一方成功，失败批次不留下其他文件', async (t) => {
  const { repo, store } = fixture(t);
  const results = await Promise.all(['Claude', 'Codex', 'Third', 'Fourth'].map((owner) => run(repo, ['claim', '--owner', owner, '--task', '并发争用', `${owner}.txt`, 'hello.txt'])));
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.code === 1 && JSON.parse(result.stderr).error === 'CLAIM_CONFLICT').length, 3);
  const rows = await store.list();
  assert.equal(rows.length, 2); assert.equal(rows[0].owner, rows[1].owner);
  const winner = JSON.parse(results.find((result) => result.code === 0).stdout);
  const release = await run(repo, ['release', '--owner', rows[0].owner, '--token', winner.token, ...rows.map((row) => row.file)]);
  assert.equal(release.code, 0, release.stderr);
  assert.deepEqual(await store.list(), []);
});

test('关联 worktree 使用同一认领记录', async (t) => {
  const { root, repo, store } = fixture(t);
  const worktree = path.join(root, 'worktree');
  git(repo, 'worktree', 'add', '--detach', worktree);
  try {
    const other = new FileClaims(worktree);
    assert.equal(other.directory, store.directory);
    await store.claim({ files: ['hello.txt'], owner: 'Codex', task: '主目录工作' });
    await assert.rejects(other.claim({ files: ['hello.txt'], owner: 'Claude', task: '隔离目录工作' }), { code: 'CLAIM_CONFLICT' });
    assert.equal((await other.list())[0].owner, 'Codex');
  } finally { git(repo, 'worktree', 'remove', worktree); }
});

test('CLI 输入错误可读，列表提供 JSON', async (t) => {
  const { repo } = fixture(t);
  const bad = await run(repo, ['claim', '--owner', 'Codex', '--task', '测试', '--minutes', '-1', 'hello.txt']);
  assert.equal(bad.code, 1); assert.match(JSON.parse(bad.stderr).message, /预计时长/);
  const list = await run(repo, ['list']);
  assert.equal(list.code, 0); assert.deepEqual(JSON.parse(list.stdout), []);
});
