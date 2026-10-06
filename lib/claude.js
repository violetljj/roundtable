// Claude 连接器：每轮发言启动一次 Claude Code 命令行（流式 JSON），按固定会话 ID 续接。
import { spawn, execSync, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';

// 每次发言时命令行都会报告一次额度使用情况，通过这里广播出去
export const claudeEvents = new EventEmitter();

export const CLAUDE_MODELS = [
  { id: '', name: '命令行默认' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'opus', name: 'Opus' },
  { id: 'fable', name: 'Fable' },
  { id: 'haiku', name: 'Haiku' },
];

// 别名对应的完整型号的初始值；实际发言时命令行会报告真实型号，以那个为准并记下来
export const CLAUDE_DEFAULT_RESOLVED = {
  '': 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
  haiku: 'claude-haiku-4-5-20251001',
};

const resolved = { ...CLAUDE_DEFAULT_RESOLVED };
claudeEvents.on('model', ({ alias, id }) => { resolved[alias] = id; });

// 别名（sonnet / opus / '' 表示命令行默认）现在对应的完整型号
export function resolveClaudeAlias(alias) {
  if (/^claude-/.test(alias ?? '')) return alias;
  return resolved[alias ?? ''] ?? null;
}

export function loadResolvedClaudeModels(map) {
  Object.assign(resolved, map ?? {});
}

export function resolvedClaudeModels() {
  return { ...resolved };
}

// claude-sonnet-5-5 → Sonnet 5.5；claude-haiku-4-5-20251001 → Haiku 4.5
export function prettyClaudeModel(id) {
  const m = String(id ?? '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/i);
  if (!m) return id || '';
  const family = m[1][0].toUpperCase() + m[1].slice(1);
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}${m[4] ? ' ' + m[4] : ''}`;
}
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// 读取命令行的登录账号（不消耗额度）
export function claudeAccount(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['auth', 'status'], { env: cleanEnv(), windowsHide: true, timeout: 20000 }, (err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        resolve({ loggedIn: s.loggedIn, email: s.email ?? null, plan: s.subscriptionType ?? null, method: s.authMethod });
      } catch {
        resolve({ loggedIn: false, error: err?.message ?? '无法读取登录状态' });
      }
    });
  });
}

// 用最小的请求（Haiku、无工具、一句话）刷新额度信息
export function probeClaudeLimits(exe) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
      { env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      try { const m = JSON.parse(line); if (m.type === 'rate_limit_event') claudeEvents.emit('rateLimit', m.rate_limit_info); } catch {}
    });
    p.on('close', resolve);
    p.on('error', resolve);
    p.stdin.end('只回复：好', 'utf8');
  });
}

// 只读：只开放读取与搜索，且不加载任何 MCP 工具
const READ_ONLY_TOOLS = 'Read,Grep,Glob';

export function findClaudeExe() {
  if (process.env.ROUNDTABLE_CLAUDE_EXE && existsSync(process.env.ROUNDTABLE_CLAUDE_EXE)) return process.env.ROUNDTABLE_CLAUDE_EXE;
  // 当前进程的 PATH 可能是旧的（例如刚改过 PATH 还没重新登录），再补上注册表里的用户 PATH
  let userPath = '';
  try {
    const out = execSync('reg query HKCU\\Environment /v Path', { encoding: 'utf8', windowsHide: true });
    userPath = (out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1] ?? '').replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? '');
  } catch {}
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...userPath.split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const exe = path.join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
    // npm 全局安装：claude.cmd 只是个壳，真正的程序在 node_modules 里
    const npmExe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(path.join(dir, 'claude.cmd')) && existsSync(npmExe)) return npmExe;
  }
  return null;
}

// 桌面版 Claude 启动的进程会带着它自己的登录信息，必须去掉，才能用命令行自己的登录
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PREVIEW)/.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_PID') delete env[k];
  }
  return env;
}

export class ClaudeAgent {
  constructor({ exe, cwd, instructions, sessionId, started = false, model = '', effort = '', forkFrom = null, name = '' }) {
    this.exe = exe;
    this.cwd = cwd;
    this.instructions = instructions;
    this.sessionId = sessionId;
    this.forkFrom = forkFrom; // 从桌面端已有的对话复制一份（原对话不受影响）
    this.name = name;
    this.started = started; // 会话是否已在磁盘上建立
    this.model = model;
    this.effort = effort;
    this.proc = null;
    this.interrupted = false;
  }

  get busy() {
    return !!this.proc;
  }

  // cb: { onDelta(text), onActivity(label) }
  async send(text, cb = {}) {
    let res = await this.#run(text, cb, this.started ? 'resume' : this.forkFrom ? 'fork' : 'new');
    // 会话状态和预期不一致时（例如上一轮在建立前就被打断），换一种方式重试一次
    if (res.retryAs) res = await this.#run(text, cb, res.retryAs);
    if (res.status === 'completed' || res.sawInit) this.started = true;
    return res;
  }

  interrupt() {
    if (!this.proc) return;
    this.interrupted = true;
    this.proc.kill();
  }

  #run(text, cb, mode) {
    return new Promise((resolve) => {
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--tools', READ_ONLY_TOOLS, '--strict-mcp-config', '--permission-mode', 'default',
        '--append-system-prompt', this.instructions,
        ...(mode === 'resume' ? ['--resume', this.sessionId]
          : mode === 'fork' ? ['--resume', this.forkFrom, '--fork-session', '--session-id', this.sessionId]
          : ['--session-id', this.sessionId]),
        ...(mode !== 'resume' && this.name ? ['--name', this.name] : []),
        ...(this.model ? ['--model', this.model] : []),
        ...(this.effort ? ['--effort', this.effort] : []),
      ];
      this.interrupted = false;
      const p = spawn(this.exe, args, { cwd: this.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      this.proc = p;
      let result = null;
      let stderr = '';
      let sawInit = false;
      let sawText = false;
      let spawnError = null;
      let modelId = null;

      readline.createInterface({ input: p.stdout }).on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          if (m.model) {
            modelId = m.model;
            claudeEvents.emit('model', { alias: this.model || '', id: m.model });
          }
        }
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev?.type === 'message_start' && sawText) cb.onDelta?.('\n\n');
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            sawText = true;
            cb.onDelta?.(ev.delta.text);
          }
        }
        if (m.type === 'assistant') {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'tool_use') cb.onActivity?.(toolLabel(block));
          }
        }
        if (m.type === 'rate_limit_event') claudeEvents.emit('rateLimit', m.rate_limit_info);
        if (m.type === 'result') result = m;
      });
      p.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      p.on('error', (e) => { spawnError = e; });
      p.on('close', (code) => {
        this.proc = null;
        if (this.interrupted) return resolve({ status: 'interrupted', text: '', sawInit, modelId });
        if (result && !result.is_error) return resolve({ status: 'completed', text: String(result.result ?? '').trim(), sawInit, modelId });
        const err = spawnError?.message || result?.result || stderr.trim() || `Claude 进程退出（${code}）`;
        if (!sawInit && mode === 'resume' && /no conversation found|not found/i.test(err)) return resolve({ retryAs: 'new' });
        if (!sawInit && mode !== 'resume' && /already in use|already exists/i.test(err)) return resolve({ retryAs: 'resume' });
        resolve({ status: 'failed', text: '', error: err.slice(0, 500), sawInit });
      });
      p.stdin.end(text, 'utf8');
    });
  }
}

function toolLabel(block) {
  const i = block.input ?? {};
  switch (block.name) {
    case 'Read': return `读取：${short(i.file_path)}`;
    case 'Grep': return `搜索：${i.pattern ?? ''}${i.path ? ' @ ' + short(i.path) : ''}`;
    case 'Glob': return `查找文件：${i.pattern ?? ''}`;
    default: return `使用工具：${block.name}`;
  }
}

function short(p) {
  p = String(p ?? '');
  return p.length > 70 ? '…' + p.slice(-69) : p;
}
