import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ClaudeAgent } from '../lib/claude.js';
import { CodexServer } from '../lib/codex.js';
import { claudeDiscussionArgs, codexDiscussionArgs, loadDiscussionTools, saveDiscussionTools } from '../lib/discussion-tools.js';

const ALL_OFF = { web: false, claudeShell: false, claudeDocs: false, codexPlugins: false };
const flag = (args, name) => args[args.indexOf(name) + 1];

test('默认全开，存取时补齐缺项并忽略非布尔值', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(loadDiscussionTools(dir), { web: true, claudeShell: true, claudeDocs: true, codexPlugins: true });
  saveDiscussionTools(dir, { web: false, claudeDocs: 'no' });
  assert.deepEqual(loadDiscussionTools(dir), { web: false, claudeShell: true, claudeDocs: true, codexPlugins: true });
});

test('Claude：全关时与原来的纯只读参数一致', () => {
  const { args, env } = claudeDiscussionArgs(ALL_OFF, 'C:\\Git\\bin\\bash.exe');
  assert.deepEqual(args, ['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--permission-mode', 'default']);
  assert.deepEqual(env, {});
});

test('Claude：全开时用 dontAsk 白名单，拒绝 --output，Bash 指向 Git Bash', () => {
  const { args, env } = claudeDiscussionArgs({}, 'C:\\Git\\bin\\bash.exe');
  assert.equal(flag(args, '--tools'), 'Read,Grep,Glob,WebSearch,WebFetch,Bash');
  assert.equal(flag(args, '--permission-mode'), 'dontAsk');
  assert.ok(!args.includes('--strict-mcp-config')); // 需要加载 exa 和 Claude Docs
  const allowed = flag(args, '--allowedTools').split(',');
  assert.ok(allowed.includes('Bash(git log:*)') && allowed.includes('mcp__plugin_exa_exa'));
  assert.ok(allowed.includes('mcp__claude_ai_Claude_Docs__read'));
  assert.ok(!allowed.some((a) => /Claude_Docs__(create|update|delete|batch)/.test(a)));
  assert.ok(!allowed.some((a) => /^Bash\((find|rg|git grep|git branch):/.test(a)));
  assert.match(flag(args, '--disallowedTools'), /Bash\(\*--output\*\)/);
  assert.deepEqual(env, { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' });
});

test('Claude：没找到 Git Bash 时不开命令；只开命令时仍跳过 MCP', () => {
  const noBash = claudeDiscussionArgs({}, null);
  assert.ok(!flag(noBash.args, '--tools').includes('Bash'));
  assert.ok(!noBash.args.includes('--disallowedTools'));
  assert.deepEqual(noBash.env, {});
  const shellOnly = claudeDiscussionArgs({ ...ALL_OFF, claudeShell: true }, 'bash.exe');
  assert.ok(shellOnly.args.includes('--strict-mcp-config'));
  assert.equal(flag(shellOnly.args, '--permission-mode'), 'dontAsk');
});

test('Codex：钩子和电脑操控功能始终关闭；插件开关整体控制', () => {
  const on = codexDiscussionArgs({});
  assert.ok(on.join(' ').includes('--disable hooks') && on.join(' ').includes('--disable computer_use'));
  assert.ok(!on.join(' ').includes('--disable plugins'));
  assert.ok(on.includes('web_search="live"') && on.some((a) => a.startsWith('mcp_servers.exa.url=')));
  assert.ok(!on.some((a) => a.includes('EXA_API_KEY')));
  const keyed = codexDiscussionArgs({}, { exaKey: true });
  // key 只按环境变量名引用，不出现在参数里
  assert.ok(keyed.includes('mcp_servers.exa.env_http_headers={ "x-api-key" = "EXA_API_KEY" }'));
  assert.ok(!codexDiscussionArgs({ web: false }, { exaKey: true }).some((a) => a.includes('exa')));
  const off = codexDiscussionArgs(ALL_OFF);
  assert.ok(off.join(' ').includes('--disable plugins') && off.join(' ').includes('--disable apps'));
  assert.ok(off.includes('web_search="disabled"') && !off.some((a) => a.startsWith('mcp_servers.')));
});

function fakeClaude() {
  const log = [];
  const spawnProcess = (exe, args, opts) => {
    const proc = new EventEmitter();
    Object.assign(proc, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    log.push({ args, opts });
    setImmediate(() => {
      proc.stdout.write(JSON.stringify({ type: 'result', result: '好' }) + '\n');
      proc.stdout.end();
      proc.emit('close', 0);
    });
    return proc;
  };
  return { log, spawnProcess };
}

test('讨论会话每次发言读取当前设置；执行会话忽略放开的参数', async () => {
  let settings = {};
  const discussionArgs = () => claudeDiscussionArgs(settings, 'bash.exe');
  const fake = fakeClaude();
  const agent = new ClaudeAgent({ exe: 'fake', cwd: process.cwd(), instructions: '', sessionId: 's', discussionArgs, spawnProcess: fake.spawnProcess });
  await agent.send('一');
  settings = ALL_OFF;
  await agent.send('二');
  assert.equal(flag(fake.log[0].args, '--permission-mode'), 'dontAsk');
  assert.equal(fake.log[0].opts.env.CLAUDE_CODE_GIT_BASH_PATH, 'bash.exe');
  assert.equal(flag(fake.log[1].args, '--permission-mode'), 'default');
  const isolated = new ClaudeAgent({ exe: 'fake', cwd: process.cwd(), instructions: '', sessionId: 'x', isolateTools: true, discussionArgs, spawnProcess: fake.spawnProcess });
  settings = {};
  await isolated.send('执行');
  assert.equal(flag(fake.log[2].args, '--tools'), 'Read,Grep,Glob');
  assert.ok(fake.log[2].args.includes('--strict-mcp-config'));
});

test('Codex 改设置：空闲立即停掉后台进程，有发言进行中等它结束', () => {
  const server = new CodexServer({ args: () => [] });
  let stops = 0;
  server.proc = {};
  server.stop = () => { stops++; };
  server.turnStarted();
  server.reconfigure();
  assert.equal(stops, 0);
  server.turnEnded();
  assert.equal(stops, 1);
  server.reconfigure();
  assert.equal(stops, 2);
});
