import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAgent } from '../lib/codex.js';
import { ClaudeAgent, applyClaudeFileChanges } from '../lib/claude.js';
import { createExecutionAgentFactory } from '../lib/execution-agents.js';

function workspace(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-execution-agent-')));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}

function fakeServer() {
  return {
    calls: [], threads: new Map(), start: async () => {},
    async request(method, args) {
      this.calls.push({ method, args });
      if (method === 'thread/start') return { thread: { id: 'fresh-thread' } };
      if (method === 'turn/start') {
        setImmediate(() => this.threads.get('fresh-thread')('turn/completed', { turn: { status: 'completed' } }));
        return { turn: { id: 'turn-1' } };
      }
      return {};
    },
  };
}

function fakeClaude(response, { pending = false } = {}) {
  const log = [];
  const spawnProcess = (exe, args, opts) => {
    const proc = new EventEmitter();
    Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null });
    proc.finish = () => {
      proc.stdout.write(JSON.stringify({ type: 'result', result: response }) + '\n');
      proc.exitCode = 0;
      proc.stdout.end();
      proc.emit('close', 0);
    };
    proc.kill = () => { proc.finish(); return true; };
    log.push({ exe, args, opts, proc });
    if (!pending) setImmediate(proc.finish);
    return proc;
  };
  return { log, spawnProcess };
}

test('Codex 默认只读，显式工作区执行使用无网络 workspaceWrite', async (t) => {
  const cwd = workspace(t);
  for (const writable of [false, true]) {
    const server = fakeServer();
    const agent = new CodexAgent(server, { cwd, instructions: '测试', writableRoot: writable ? cwd : null });
    await agent.send('执行');
    const start = server.calls.find((call) => call.method === 'thread/start').args;
    const turn = server.calls.find((call) => call.method === 'turn/start').args;
    assert.equal(start.sandbox, writable ? 'workspace-write' : 'read-only');
    assert.equal(start.approvalPolicy, 'never');
    assert.deepEqual(turn.sandboxPolicy, writable
      ? { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: 'readOnly', networkAccess: false });
  }
});

test('可写连接器拒绝非匹配目录与已有讨论上下文', (t) => {
  const cwd = workspace(t);
  const other = workspace(t);
  for (const create of [
    (opts) => new CodexAgent(fakeServer(), opts),
    (opts) => new ClaudeAgent({ exe: 'fake', sessionId: 'fresh', ...opts }),
  ]) {
    assert.throws(() => create({ cwd, writableRoot: other }), /绝对工作区/);
    assert.throws(() => create({ cwd: '.', writableRoot: cwd }), /绝对工作区/);
    assert.throws(() => create({ cwd, writableRoot: cwd, forkFrom: 'discussion' }), /全新对话/);
  }
  assert.throws(() => new CodexAgent(fakeServer(), { cwd, writableRoot: cwd, threadId: 'discussion' }), /全新对话/);
});

test('Claude 默认只读且不会把普通回答当成文件变更', async (t) => {
  const cwd = workspace(t);
  const fake = fakeClaude('普通讨论回答');
  const agent = new ClaudeAgent({ exe: 'fake', cwd, instructions: '', sessionId: 'fresh', spawnProcess: fake.spawnProcess });
  const result = await agent.send('讨论');
  const args = fake.log[0].args;
  assert.equal(result.text, '普通讨论回答');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(!args.includes('--allowedTools'));
});

test('Claude 受限执行由宿主新增和覆盖文本，并明确没有运行测试', async (t) => {
  const cwd = workspace(t);
  fs.writeFileSync(path.join(cwd, 'existing.txt'), '旧内容');
  const payload = { summary: '完成修改', changes: [
    { path: 'existing.txt', content: '新内容' }, { path: 'src/new.txt', content: '新增文件\n' },
  ] };
  const fake = fakeClaude('```json\n' + JSON.stringify(payload) + '\n```');
  const agent = new ClaudeAgent({ exe: 'fake', cwd, writableRoot: cwd, instructions: '', sessionId: 'fresh', spawnProcess: fake.spawnProcess });
  const deltas = [];
  const result = await agent.send('执行', { onDelta: (text) => deltas.push(text) });
  assert.equal(result.status, 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'existing.txt'), 'utf8'), '新内容');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/new.txt'), 'utf8'), '新增文件\n');
  assert.match(result.text, /未运行命令或测试/);
  assert.deepEqual(deltas, [result.text]);
  const args = fake.log[0].args;
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
  assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), { disableAllHooks: true });
});

test('路径越界、Git/凭证、删除、重复路径全部在任何落盘之前被拒绝', (t) => {
  const cwd = workspace(t);
  const invalid = ['../outside.txt', '/outside.txt', 'C:\\outside.txt', '.git/config', '.env', '.claude/settings.json', 'file.txt:stream', 'NUL.txt'];
  for (const bad of invalid) {
    assert.throws(() => applyClaudeFileChanges(cwd, JSON.stringify({ summary: '', changes: [
      { path: 'valid.txt', content: '不能先写入' }, { path: bad, content: '不能写入' },
    ] })));
    assert.equal(fs.existsSync(path.join(cwd, 'valid.txt')), false);
  }
  for (const changes of [
    [{ path: 'delete.txt', content: null }],
    [{ path: 'same.txt', content: 'a' }, { path: 'same.txt', content: 'b' }],
    [{ path: 'parent', content: 'a' }, { path: 'parent/child', content: 'b' }],
  ]) assert.throws(() => applyClaudeFileChanges(cwd, JSON.stringify({ summary: '', changes })));
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('宿主拒绝 junction 和硬链接，不能借工作区路径覆盖外部文件', (t) => {
  const cwd = workspace(t);
  const outside = workspace(t);
  fs.writeFileSync(path.join(outside, 'outside.txt'), '保留');
  fs.symlinkSync(outside, path.join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.linkSync(path.join(outside, 'outside.txt'), path.join(cwd, 'hardlink.txt'));
  for (const relative of ['linked/outside.txt', 'hardlink.txt']) {
    assert.throws(() => applyClaudeFileChanges(cwd, JSON.stringify({ summary: '', changes: [{ path: relative, content: '不允许' }] })), /链接/);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'outside.txt'), 'utf8'), '保留');
});

test('取消后即使 Claude 返回 completed 文件数据，也不能落盘', async (t) => {
  const cwd = workspace(t);
  const fake = fakeClaude(JSON.stringify({ summary: '修改', changes: [{ path: 'cancelled.txt', content: '不允许' }] }), { pending: true });
  const agent = new ClaudeAgent({ exe: 'fake', cwd, writableRoot: cwd, instructions: '', sessionId: 'fresh', spawnProcess: fake.spawnProcess });
  const pending = agent.send('执行');
  agent.interrupt();
  assert.equal((await pending).status, 'interrupted');
  assert.equal(fs.existsSync(path.join(cwd, 'cancelled.txt')), false);
});

test('工厂每次建立新会话与专有 Codex server，释放不碰讨论 server', async (t) => {
  const cwd = workspace(t);
  const shared = { stops: 0, stop() { this.stops++; } };
  const factory = createExecutionAgentFactory({ codexServer: shared, claudeExe: 'fake' });
  const before = process.listenerCount('exit');
  const agents = [factory({ who: 'codex', cwd, writable: true }), factory({ who: 'codex', cwd }),
    factory({ who: 'claude', cwd, writable: true }), factory({ who: 'claude', cwd })];
  assert.notEqual(agents[0].server, shared);
  assert.notEqual(agents[0].server, agents[1].server);
  assert.equal(agents[0].threadId, null);
  assert.equal(agents[1].writableRoot, null);
  assert.notEqual(agents[2].sessionId, agents[3].sessionId);
  assert.equal(agents[2].forkFrom, null);
  assert.match(agents[0].instructions, /禁止 Git 提交/);
  for (const agent of agents) { await agent.dispose(); await agent.dispose(); }
  assert.equal(shared.stops, 0);
  assert.equal(process.listenerCount('exit'), before);
  await assert.rejects(agents[0].send('已经释放'), /已释放/);
});

test('释放运行中的 Claude 任务会结束自有进程并禁止取消后保存', async (t) => {
  const cwd = workspace(t);
  const factory = createExecutionAgentFactory({ claudeExe: 'fake' });
  const agent = factory({ who: 'claude', cwd, writable: true });
  const fake = fakeClaude(JSON.stringify({ summary: '不能保存', changes: [{ path: 'late.txt', content: '不能保存' }] }), { pending: true });
  agent.spawnProcess = fake.spawnProcess;
  const pending = agent.send('执行');
  await agent.dispose();
  assert.equal((await pending).status, 'interrupted');
  assert.equal(fake.log[0].proc.exitCode, 0);
  assert.equal(fs.existsSync(path.join(cwd, 'late.txt')), false);
});
