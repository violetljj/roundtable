import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { Experiment } from '../lib/experiment.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 8000;
  while (!fn()) { if (Date.now() > end) throw new Error('等待超时'); await delay(10); }
}
const card = { question: '排序是否稳定？', decisionRule: '相同键保持原顺序则支持稳定性', procedure: '用本地 Node 对三个固定输入运行排序并记录输出。' };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-experiment-test-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'input.txt'), 'original\n');
  git(repo, 'add', 'input.txt');
  git(repo, 'commit', '-m', 'Initial');
  const room = new EventEmitter();
  Object.assign(room, { dir: path.join(root, 'room'), speaking: new Map(), d: {
    cwd: repo, phase: 'discussion', status: 'paused', models: {}, facts: { version: 1, text: '不增加依赖' }, messages: [],
  } });
  const calls = [];
  const agentFactory = async (args) => {
    const call = { ...args, disposed: false, interrupted: false };
    calls.push(call);
    if (options.initDelay) await delay(options.initDelay);
    let resolve;
    return {
      async send(prompt, cb) {
        call.prompt = prompt;
        if (options.write) fs.writeFileSync(path.join(args.cwd, 'observation.txt'), 'evidence');
        if (options.sourceChange) fs.writeFileSync(path.join(repo, 'input.txt'), 'concurrent change');
        if (options.hang) return new Promise((done) => { resolve = done; });
        if (options.empty) return { status: 'completed', text: '' };
        const text = options.fail ? '只完成了第一个输入。' : '实际命令：node -e。观察：三个固定输入保留相同键的原顺序。仅证明这些样例。';
        cb.onDelta(text);
        return { status: options.fail ? 'failed' : 'completed', text, error: options.fail ? '测试中断' : '' };
      },
      interrupt() { call.interrupted = true; if (options.stuckInterrupt) return new Promise(() => {}); resolve?.({ status: 'interrupted', text: '' }); },
      dispose() { call.disposed = true; resolve?.({ status: 'interrupted', text: '' }); },
    };
  };
  const experiment = new Experiment(room, { agentFactory, worktreeRoot: path.join(root, 'worktrees'), timeoutMs: options.timeoutMs });
  t.after(async () => {
    await experiment.dispose();
    if (experiment.pendingOperation) await experiment.pendingOperation.catch(() => {});
    assert.equal(fs.realpathSync(root), root);
    const checkLinks = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false, file);
        if (stat.isDirectory()) checkLinks(file);
      }
    };
    checkLinks(root);
    // 测试只清理自身创建且核对过的临时目录；Windows 不用 Force。
    if (process.platform === 'win32') {
      const literal = root.replaceAll("'", "''");
      // Git 对象默认为只读；仅还原本测试树的属性后以普通删除收尾。
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$experimentCleanupRoot = (Resolve-Path -LiteralPath '${literal}').Path; Get-ChildItem -LiteralPath $experimentCleanupRoot -Force -Recurse | ForEach-Object { if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '拒绝清理链接' }; $_.Attributes = $_.Attributes -band (-bnot ([IO.FileAttributes]::ReadOnly -bor [IO.FileAttributes]::Hidden)) }; Remove-Item -LiteralPath $experimentCleanupRoot -Recurse -ErrorAction Stop`], { windowsHide: true });
    } else fs.rmSync(root, { recursive: true });
    assert.equal(fs.existsSync(root), false);
  });
  return { root, repo, room, calls, experiment, agentFactory };
}
async function run(experiment, extra = {}) {
  await experiment.start({ confirmed: true, card, budgetMinutes: 1, ...extra });
  await experiment.job;
  return experiment.snapshot();
}

test('定向实验草稿引用原发言，冻结与历史保留关联，新卡不继承来源', async (t) => {
  const { experiment, room, agentFactory } = fixture(t);
  room.d.messages.push({ id: 'source', from: 'claude', status: 'complete', text: '建议固定输入检查排序是否稳定。' });
  await experiment.saveCard({ card, sourceMessageId: 'source', sourceExcerpt: '固定输入检查排序' });
  const restored = new Experiment(room, { agentFactory });
  assert.equal(restored.d.sourceMessageId, 'source');
  assert.equal(restored.d.sourceExcerpt, '固定输入检查排序');
  const result = await run(experiment);
  assert.equal(result.source.sourceMessageId, 'source');
  assert.equal(result.source.sourceExcerpt, '固定输入检查排序');
  await experiment.returnResult({ confirmed: true });
  await experiment.saveCard({ newExperiment: true, card });
  assert.equal(experiment.d.sourceMessageId, undefined);
  assert.equal(experiment.d.history[0].sourceMessageId, 'source');
});

test('实验来源拒绝非完整模型发言和伪造引用，失败不污染已存草稿', async (t) => {
  const { experiment, room } = fixture(t);
  room.d.messages.push(
    { id: 'source', from: 'codex', status: 'complete', text: '有效原文' },
    { id: 'failed', from: 'claude', status: 'failed', text: '失败原文' },
    { id: 'user', from: 'user', status: 'complete', text: '用户原文' },
  );
  await experiment.saveCard({ card, sourceMessageId: 'source', sourceExcerpt: '有效' });
  const saved = experiment.snapshot();
  for (const body of [
    { sourceMessageId: 'missing' }, { sourceMessageId: 'failed' }, { sourceMessageId: 'user' }, { sourceMessageId: null },
    { sourceExcerpt: '并未说过' }, { sourceExcerpt: {} }, { sourceExcerpt: null }, { sourceExcerpt: '长'.repeat(12001) },
  ]) await assert.rejects(experiment.saveCard(body), /来源|引用/);
  assert.deepEqual(experiment.snapshot(), saved);
  room.d.phase = 'independent';
  await assert.rejects(experiment.saveCard({ card, sourceMessageId: 'source' }), /交叉讨论/);
});

test('实验必须明确批准，暂停且无人发言后才运行', async (t) => {
  const { experiment, room, calls } = fixture(t);
  await assert.rejects(experiment.start({ card }), /批准/);
  room.d.status = 'running';
  await assert.rejects(experiment.start({ confirmed: true, card }), /暂停/);
  room.d.status = 'paused'; room.d.phase = 'summary';
  await assert.rejects(experiment.start({ confirmed: true, card }), /交叉讨论/);
  room.d.phase = 'discussion'; room.speaking.set('claude', true);
  await assert.rejects(experiment.start({ confirmed: true, card }), /发言/);
  room.speaking.clear();
  room.handoff = { d: { status: 'running' } };
  await assert.rejects(experiment.start({ confirmed: true, card }), /交接/);
  assert.equal(calls.length, 0);
});

test('冻结批准卡和来源，独立 Codex 沙盒完成后保留报告，来源不变且不自动恢复', async (t) => {
  const { experiment, repo, room, calls } = fixture(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  const result = await run(experiment);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.baseHead, head);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(repo, 'input.txt'), 'utf8'), 'original\n');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(room.d.status, 'paused');
  assert.deepEqual(calls.map((c) => [c.who, c.writable]), [['codex', true]]);
  assert.ok(calls[0].cwd !== repo && calls[0].disposed);
  assert.equal(result.worktreeRemoved, true, result.cleanupError);
  const archived = JSON.parse(fs.readFileSync(path.join(room.dir, 'experiments', result.id + '.json')));
  assert.deepEqual(archived.card, card);
  assert.equal(archived.report, result.report);
  await assert.rejects(experiment.returnResult(), /确认/);
  const returned = await experiment.returnResult({ confirmed: true });
  assert.match(returned.evidence, /非用户指令/);
  assert.match(returned.evidence, /不代表假设成立/);
  assert.equal((await experiment.returnResult({ confirmed: true })).evidence, null);
  await experiment.saveCard({ newExperiment: true, card });
  assert.notEqual(experiment.d.id, result.id);
  assert.ok(fs.existsSync(path.join(room.dir, 'experiments', result.id + '.json')));
});

test('实验产物保留在独立工作区，不合并或提交', async (t) => {
  const { experiment, repo } = fixture(t, { write: true });
  const result = await run(experiment);
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.cleanupError, /产物/);
  assert.equal(fs.readFileSync(path.join(result.worktree, 'observation.txt'), 'utf8'), 'evidence');
  assert.equal(fs.existsSync(path.join(repo, 'observation.txt')), false);
  assert.equal(git(result.worktree, 'rev-parse', 'HEAD'), result.baseHead);
});

test('失败保留部分报告且回传明确失败，不冒充成功', async (t) => {
  const { experiment, calls } = fixture(t, { fail: true });
  const result = await run(experiment);
  assert.equal(result.status, 'failed');
  assert.match(result.report, /第一个/);
  assert.ok(fs.existsSync(result.worktree));
  assert.ok(calls[0].disposed);
  assert.match((await experiment.returnResult({ confirmed: true })).evidence, /执行状态：failed/);
});

test('空报告不能标记完成', async (t) => {
  const { experiment } = fixture(t, { empty: true });
  const result = await run(experiment);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /完整报告/);
});

test('取消释放执行器，保留现场并不自动恢复', async (t) => {
  const { experiment, calls, room } = fixture(t, { hang: true });
  await experiment.start({ confirmed: true, card });
  await until(() => calls[0]?.prompt);
  const result = await experiment.cancel();
  assert.equal(result.status, 'cancelled');
  assert.ok(calls[0].disposed && calls[0].interrupted);
  assert.ok(fs.existsSync(result.worktree));
  assert.equal(room.d.status, 'paused');
});

test('中断回执卡住仍调用 dispose 释放，不阻挡取消', async (t) => {
  const { experiment, calls } = fixture(t, { hang: true, stuckInterrupt: true });
  await experiment.start({ confirmed: true, card });
  await until(() => calls[0]?.prompt);
  const result = await experiment.cancel();
  assert.equal(result.status, 'cancelled');
  assert.ok(calls[0].disposed);
});

test('回传接收失败可重试，接收成功后才记录 returned', async (t) => {
  const { experiment } = fixture(t);
  await run(experiment);
  await assert.rejects(experiment.returnResult({ confirmed: true }, () => { throw new Error('接收失败'); }), /接收失败/);
  assert.equal(experiment.d.status, 'completed');
  let accepted;
  await experiment.returnResult({ confirmed: true }, (evidence, id) => { accepted = { evidence, id }; });
  assert.equal(accepted.id, experiment.d.id);
  assert.match(accepted.evidence, /非用户指令/);
  assert.equal(experiment.d.status, 'returned');
});

test('预算超时停止并释放会话，严格拒绝无效预算', async (t) => {
  const { experiment, calls } = fixture(t, { hang: true, timeoutMs: 500 });
  await assert.rejects(experiment.saveCard({ card, budgetMinutes: 31 }), /1–30/);
  const result = await run(experiment);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /时限/);
  assert.ok(calls[0]?.disposed);
});

test('初始化也受预算约束，迟到执行器不得运行且最终释放', async (t) => {
  const { experiment, calls } = fixture(t, { initDelay: 700, timeoutMs: 400 });
  const result = await run(experiment);
  assert.equal(result.status, 'failed');
  await until(() => calls[0]?.disposed);
  assert.equal(calls[0].prompt, undefined);
});

test('重启活动实验标记失败，不自动重跑', async (t) => {
  const { experiment, room, agentFactory, calls } = fixture(t);
  await experiment.saveCard({ card });
  const saved = { ...experiment.snapshot(), status: 'running' };
  fs.writeFileSync(experiment.file, JSON.stringify(saved));
  const restored = new Experiment(room, { agentFactory });
  assert.equal(restored.d.status, 'failed');
  assert.match(restored.d.error, /重启/);
  assert.equal(calls.length, 0);
});

test('源目录脏时拒绝，执行时来源漂移保留报告并标失败', async (t) => {
  const { experiment, repo } = fixture(t, { sourceChange: true });
  fs.writeFileSync(path.join(repo, 'input.txt'), 'uncommitted');
  await assert.rejects(experiment.start({ confirmed: true, card }), /未提交/);
  fs.writeFileSync(path.join(repo, 'input.txt'), 'original\n');
  const result = await run(experiment);
  assert.equal(result.status, 'failed');
  assert.equal(result.sourceUnchanged, false);
  assert.match(result.error, /源项目发生变化/);
  assert.match(result.report, /观察/);
});
