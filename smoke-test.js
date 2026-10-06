// 冒烟测试：对两边各走一遍「启动 → 发言 → 打断 → 恢复」，用来发现 Claude/Codex 升级后的行为变化。
// 用法：node smoke-test.js   （会消耗很少的额度）
import { randomUUID } from 'node:crypto';
import { CodexServer, CodexAgent } from './lib/codex.js';
import { ClaudeAgent, findClaudeExe } from './lib/claude.js';

const cwd = process.cwd();
const instructions = '这是自动化测试。回答尽量简短。';
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}

async function interruptAfterFirstDelta(agent, prompt) {
  let fired = false;
  return agent.send(prompt, {
    onDelta: () => { if (!fired) { fired = true; agent.interrupt(); } },
  });
}

async function testCodex() {
  console.log('\n== Codex（app-server）');
  const server = new CodexServer();
  try {
    await server.start();
    check('启动 app-server 并完成握手', true);
    const agent = new CodexAgent(server, { cwd, instructions });
    const r1 = await agent.send('记住暗号「青柠」。只回复：好');
    check('发言', r1.status === 'completed' && r1.text.length > 0, JSON.stringify(r1.text));
    const r2 = await interruptAfterFirstDelta(agent, '从 1 数到 200，每个数字单独一行。');
    check('打断', r2.status === 'interrupted', r2.status);
    // 换一个全新的 app-server 进程，按 ID 接回同一个会话
    const threadId = agent.threadId;
    server.stop();
    await new Promise((r) => setTimeout(r, 500));
    const server2 = new CodexServer();
    const agent2 = new CodexAgent(server2, { cwd, instructions, threadId });
    const r3 = await agent2.send('我让你记住的暗号是什么？只回复暗号。');
    check('按 ID 恢复会话（新进程）', r3.status === 'completed' && r3.text.includes('青柠'), JSON.stringify(r3.text));
    server2.stop();
  } catch (e) {
    check('Codex 测试', false, e.message);
    server.stop();
  }
}

async function testClaude() {
  console.log('\n== Claude（命令行）');
  const exe = findClaudeExe();
  check('找到 Claude 命令行', !!exe, exe ?? '请确认 claude 已安装并在 PATH 中');
  if (!exe) return;
  const sessionId = randomUUID();
  const agent = new ClaudeAgent({ exe, cwd, instructions, sessionId, model: 'sonnet' });
  const r1 = await agent.send('记住暗号「青柠」。只回复：好');
  check('发言', r1.status === 'completed' && r1.text.length > 0, JSON.stringify(r1.text ?? r1.error));
  const r2 = await interruptAfterFirstDelta(agent, '从 1 数到 200，每个数字单独一行。');
  check('打断', r2.status === 'interrupted', r2.status);
  const agent2 = new ClaudeAgent({ exe, cwd, instructions, sessionId, started: true, model: 'sonnet' });
  const r3 = await agent2.send('我让你记住的暗号是什么？只回复暗号。');
  check('按 ID 恢复会话', r3.status === 'completed' && r3.text.includes('青柠'), JSON.stringify(r3.text ?? r3.error));
}

await testCodex();
await testClaude();
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
