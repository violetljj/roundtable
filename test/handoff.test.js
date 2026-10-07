import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { Handoff } from '../lib/handoff.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw new Error('等待条件超时'); await pause(10); }
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-handoff-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'hello.txt'), 'before\n');
  git(repo, 'add', 'hello.txt');
  git(repo, 'commit', '-m', 'Initial');
  const room = new EventEmitter();
  Object.assign(room, {
    dir: path.join(root, 'room'), speaking: new Map(),
    d: { cwd: repo, phase: 'done', status: 'waiting', topic: '更改问候语',
      facts: { version: 2, text: '保持零依赖' }, models: {},
      messages: [
        { id: 'summary-1', kind: 'summary', status: 'complete', text: '更新 hello.txt' },
        { id: 'review-1', kind: 'review', status: 'complete', text: '复核更正：保留换行' },
      ],
    },
  });
  const calls = [];
  const agentFactory = (args) => {
    const record = { ...args, interrupted: false, disposed: false };
    calls.push(record);
    let complete;
    return {
      async send(prompt, cb) {
        record.prompt = prompt;
        if (args.writable) {
          fs.writeFileSync(path.join(args.cwd, 'hello.txt'), 'after\n');
          if (options.hang) return new Promise((resolve) => { complete = resolve; });
          if (options.execute) await options.execute(args);
        } else if (options.review) await options.review(args);
        if (options.fail && args.writable) return { status: 'failed', error: '模拟执行失败' };
        const text = args.writable ? '完成，检查问候语通过。' : '审查完成，未发现阻塞问题。';
        cb.onDelta?.(text);
        return { status: 'completed', text };
      },
      interrupt() { record.interrupted = true; complete?.({ status: 'interrupted', text: '' }); },
      dispose() { record.disposed = true; },
    };
  };
  const handoff = new Handoff(room, { agentFactory, worktreeRoot: path.join(root, 'worktrees'), timeoutMs: options.timeoutMs });
  t.after(async () => {
    if (['running', 'reviewing'].includes(handoff.d?.status)) await handoff.cancel();
    // 测试根目录由本测试创建，清理前核对实际位置；Git 工作树登记随仓库一起结束。
    assert.equal(fs.realpathSync(root), root);
    fs.rmSync(root, { recursive: true });
  });
  return { root, repo, room, handoff, calls, agentFactory };
}

async function run(handoff, extra = {}) {
  await handoff.start({ confirmed: true, card: { acceptance: 'hello.txt 等于 after 并保留换行' }, ...extra });
  await handoff.job;
}

test('完整交接：冻结卡片、隔离执行、另一方审查、确认后快进合并', async (t) => {
  const { handoff, calls, repo, room } = fixture(t);
  const draft = handoff.snapshot();
  assert.equal(draft.card.constraints, '保持零依赖');
  assert.match(draft.card.disagreements, /保留换行/);
  await assert.rejects(handoff.start({}), /确认/);
  await run(handoff);
  assert.equal(handoff.d.status, 'ready', handoff.d.error);
  assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'before\n');
  assert.deepEqual(calls.map((c) => [c.who, c.writable]), [['codex', true], ['claude', false]]);
  assert.ok(calls.every((c) => c.cwd !== repo && c.disposed));
  assert.match(calls[1].prompt, /after/);
  assert.match(calls[1].prompt, new RegExp(handoff.d.commit));
  room.d.facts.text = '修改后的约束';
  assert.equal(handoff.d.source.facts.text, '保持零依赖');
  await assert.rejects(handoff.start({ confirmed: true }), /待确认/);
  await assert.rejects(handoff.merge({}), /确认/);
  await assert.rejects(handoff.merge({ confirmed: true, commit: 'outdated' }), /提交编号/);
  const result = await handoff.merge({ confirmed: true, commit: handoff.d.commit });
  assert.equal(result.status, 'merged');
  assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'after\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(result.worktreeRemoved, true, result.cleanupError);
  assert.equal(fs.existsSync(result.worktree), false);
  assert.equal(git(repo, 'rev-parse', result.branch), result.commit);
});

test('原项目脏文件阻止启动和合并，不覆盖已有文件', async (t) => {
  const { handoff, repo, calls } = fixture(t);
  fs.writeFileSync(path.join(repo, 'user.txt'), '用户改动');
  await assert.rejects(handoff.start({ confirmed: true, acceptance: '检查输出' }), /未提交/);
  assert.equal(calls.length, 0);
  fs.unlinkSync(path.join(repo, 'user.txt'));
  await run(handoff);
  fs.writeFileSync(path.join(repo, 'hello.txt'), '用户改动');
  await assert.rejects(handoff.merge({ confirmed: true, commit: handoff.d.commit }), /未提交/);
  assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), '用户改动');
  assert.equal(handoff.d.status, 'ready');
});

test('项目 HEAD 或分支漂移时拒绝自动整合', async (t) => {
  const { handoff, repo } = fixture(t);
  await run(handoff);
  git(repo, 'checkout', '-b', 'another');
  await assert.rejects(handoff.merge({ confirmed: true, commit: handoff.d.commit }), /HEAD 已变化/);
  git(repo, 'checkout', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'Other work');
  await assert.rejects(handoff.merge({ confirmed: true, commit: handoff.d.commit }), /HEAD 已变化/);
  assert.equal(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8'), 'before\n');
});

test('取消正在执行的任务，停止模型并保留脏工作区', async (t) => {
  const { handoff, calls } = fixture(t, { hang: true });
  await handoff.start({ confirmed: true, acceptance: '检查输出' });
  await until(() => calls[0]?.prompt);
  await handoff.cancel();
  assert.equal(handoff.d.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interrupted, true);
  await handoff.discard();
  assert.equal(handoff.d.status, 'discarded');
  assert.equal(fs.existsSync(handoff.d.worktree), true);
  assert.match(handoff.d.cleanupError, /未提交/);
});

test('时间上限停止挂起的调用且不启动审查', async (t) => {
  const { handoff, calls } = fixture(t, { hang: true, timeoutMs: 700 });
  await run(handoff);
  assert.equal(handoff.d.status, 'failed');
  assert.match(handoff.d.error, /时限/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].interrupted, true);
  assert.equal(calls[0].disposed, true);
});

test('重启把活动任务标为失败，保留证据且不重启模型', async (t) => {
  const { handoff, room, agentFactory, calls } = fixture(t);
  await run(handoff);
  const saved = JSON.parse(fs.readFileSync(handoff.file));
  saved.status = 'reviewing';
  fs.writeFileSync(handoff.file, JSON.stringify(saved));
  const recovered = new Handoff(room, { agentFactory });
  assert.equal(recovered.d.status, 'failed');
  assert.match(recovered.d.error, /重启/);
  assert.equal(recovered.d.commit, saved.commit);
  assert.equal(calls.length, 2);
  assert.equal(recovered.job, null);
});

test('审查后修改工作区阻止 ready，失败保留现场', async (t) => {
  const { handoff } = fixture(t, { review: ({ cwd }) => fs.writeFileSync(path.join(cwd, 'hello.txt'), '未审查修改') });
  await run(handoff);
  assert.equal(handoff.d.status, 'failed');
  assert.match(handoff.d.error, /未提交/);
  assert.equal(fs.existsSync(handoff.d.worktree), true);
});

test('仅完成的最终结论生成卡片，忙碌和来源更新阻止启动', async (t) => {
  const { handoff, room } = fixture(t);
  room.d.phase = 'discussion';
  assert.equal(handoff.snapshot(), null);
  room.d.phase = 'done';
  room.d.messages.push({ id: 'final-1', kind: 'final', status: 'complete', text: '采纳复核的最终方案' });
  assert.equal(handoff.snapshot().card.plan, '采纳复核的最终方案');
  room.speaking.set('codex', {});
  await assert.rejects(handoff.start({ confirmed: true, acceptance: '检查输出' }), /无人发言/);
  room.speaking.clear();
  room.d.facts.version++;
  await assert.rejects(handoff.start({ confirmed: true, acceptance: '检查输出' }), /已变化/);
  await handoff.saveCard({ regenerate: true });
  assert.equal(handoff.d.source.facts.version, room.d.facts.version);
  const before = handoff.snapshot();
  await assert.rejects(handoff.saveCard({ card: { goal: '不应保存' }, executor: 'invalid' }), /执行方/);
  assert.deepEqual(handoff.snapshot(), before);
});

test('忽略的运行产物阻止自动清理，合并结果和证据保留', async (t) => {
  const { handoff } = fixture(t, { execute: ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), 'cache/\n');
    fs.mkdirSync(path.join(cwd, 'cache'));
    fs.writeFileSync(path.join(cwd, 'cache', 'result.txt'), '验收证据');
  } });
  await run(handoff);
  assert.equal(handoff.d.status, 'ready', handoff.d.error);
  await handoff.merge({ confirmed: true, commit: handoff.d.commit });
  assert.equal(handoff.d.status, 'merged');
  assert.equal(fs.existsSync(handoff.d.worktree), true);
  assert.match(handoff.d.cleanupError, /未提交/);
});

test('源项目被忽略的本机文件不会被快进合并覆盖', async (t) => {
  const { handoff, repo } = fixture(t, { execute: ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, '.gitignore'), '');
    fs.writeFileSync(path.join(cwd, 'config.local.json'), '任务生成内容');
  } });
  fs.writeFileSync(path.join(repo, '.gitignore'), 'config.local.json\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-m', 'Ignore local settings');
  fs.writeFileSync(path.join(repo, 'config.local.json'), '用户原始配置');
  await run(handoff);
  assert.equal(handoff.d.status, 'ready', handoff.d.error);
  await assert.rejects(handoff.merge({ confirmed: true, commit: handoff.d.commit }), /overwritten|覆盖/);
  assert.equal(fs.readFileSync(path.join(repo, 'config.local.json'), 'utf8'), '用户原始配置');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), handoff.d.baseHead);
});

test('审查完成后的 Git 核验期间取消，不会再进入 ready', async (t) => {
  const { handoff, calls } = fixture(t);
  await handoff.start({ confirmed: true, acceptance: '检查输出' });
  await until(() => calls[1]?.disposed);
  assert.equal(handoff.d.status, 'reviewing');
  await handoff.cancel();
  assert.equal(handoff.d.status, 'cancelled');
  assert.equal(calls.length, 2);
});

test('执行失败保留现场且不调用审查', async (t) => {
  const { handoff, calls } = fixture(t, { fail: true });
  await run(handoff);
  assert.equal(handoff.d.status, 'failed');
  assert.equal(calls.length, 1);
  assert.match(handoff.d.error, /模拟执行失败/);
  assert.equal(fs.readFileSync(path.join(handoff.d.worktree, 'hello.txt'), 'utf8'), 'after\n');
});

test('连接器初始化期间取消，创建后的 agent 仍被释放', async (t) => {
  const { handoff, calls, agentFactory } = fixture(t);
  let release;
  handoff.agentFactory = (args) => new Promise((resolve) => { release = () => resolve(agentFactory(args)); });
  await handoff.start({ confirmed: true, acceptance: '检查输出' });
  await until(() => release);
  const cancelled = handoff.cancel();
  release();
  await cancelled;
  assert.equal(handoff.d.status, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, undefined);
  assert.equal(calls[0].disposed, true);
  assert.equal(handoff.agent, null);
});

test('凭证文件阻止主持程序提交', async (t) => {
  const { handoff, calls } = fixture(t, { execute: ({ cwd }) => fs.writeFileSync(path.join(cwd, '.env'), 'TEST_TOKEN=fake-test-value') });
  await run(handoff);
  assert.equal(handoff.d.status, 'failed');
  assert.match(handoff.d.error, /本机配置/);
  assert.equal(calls.length, 1);
  assert.equal(git(handoff.d.worktree, 'rev-parse', 'HEAD'), handoff.d.baseHead);
});

test('建立工作区、提交和合并都不执行仓库 hooks', async (t) => {
  const { handoff, repo, root } = fixture(t);
  const marker = path.join(root, 'hook-ran.txt').replaceAll('\\', '/');
  for (const name of ['post-checkout', 'pre-commit', 'post-commit', 'post-merge']) {
    fs.writeFileSync(path.join(repo, '.git', 'hooks', name), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
  }
  await run(handoff);
  assert.equal(handoff.d.status, 'ready', handoff.d.error);
  await handoff.merge({ confirmed: true, commit: handoff.d.commit });
  assert.equal(fs.existsSync(marker), false);
});
