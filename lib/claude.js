// Claude 连接器：每轮发言启动一次 Claude Code 命令行（流式 JSON），按固定会话 ID 续接。
import { spawn, execSync, execFile } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
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

// 只读：只开放读取与搜索，且不加载任何 MCP 工具。讨论会话可由 discussionArgs 按全局设置放开（见 discussion-tools.js）。
const READ_ONLY_TOOLS = 'Read,Grep,Glob';
const READ_ONLY_ARGS = ['--tools', READ_ONLY_TOOLS, '--strict-mcp-config', '--permission-mode', 'default'];

const FILE_CHANGE_INSTRUCTIONS = `
【受限文件执行】你的工具只能读取文件。需要修改时，由宿主校验后保存文件，你不能直接写文件或运行命令。
最终回答必须是一个 JSON 对象，可放在 json 代码块内：{"summary":"完成内容与未验证项","changes":[{"path":"相对工作区路径","content":"该 UTF-8 文件的完整新内容"}]}。
只支持普通文本文件的新增和覆盖；不支持删除、二进制、链接、Git 元数据、凭证和工具配置。无改动时 changes 为 []。
读取后再修改；完整保留不相关内容。不要声称运行了测试，不要提交或推送 Git。不要把 JSON 分散到多段回答。`;

// Claude 只生成数据，写入权留给宿主；所有路径检查完成后才开始保存。
export function applyClaudeFileChanges(root, response) {
  const canonical = fs.realpathSync(root);
  if (!path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink() || !fs.statSync(canonical).isDirectory()) throw new Error('执行工作区无效');
  const raw = String(response).trim().replace(/^```(?:json|roundtable-changes)?\s*\n([\s\S]*)\n```$/, '$1');
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error('Claude 未返回有效的文件变更 JSON，未保存文件'); }
  if (!payload || typeof payload.summary !== 'string' || !Array.isArray(payload.changes)
    || payload.changes.length > 100) throw new Error('文件变更格式无效，未保存文件');
  const paths = new Set();
  let bytes = 0;
  const prepared = payload.changes.map((change) => {
    if (!change || typeof change.path !== 'string' || typeof change.content !== 'string'
      || change.content.includes('\0')) throw new Error('只支持 UTF-8 文本文件新增和覆盖');
    const parts = change.path.replace(/\\/g, '/').split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      || /^(\.git|\.claude|\.codex|\.ssh|\.aws|\.azure|\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))) {
      throw new Error(`不允许保存此路径：${change.path}`);
    }
    const target = path.join(canonical, ...parts);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (paths.has(key)) throw new Error(`重复文件路径：${change.path}`);
    paths.add(key);
    bytes += Buffer.byteLength(change.content, 'utf8');
    if (bytes > 4 * 1024 * 1024) throw new Error('单次文件变更超过 4 MiB，未保存文件');
    let cursor = canonical;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      let stat;
      try { stat = fs.lstatSync(cursor); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error(`不允许修改链接路径：${change.path}`);
      if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`父路径不是目录：${change.path}`);
      if (i === parts.length - 1 && !stat.isFile()) throw new Error(`目标不是普通文件：${change.path}`);
      const relative = path.relative(canonical, fs.realpathSync(cursor));
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('路径越出执行工作区');
    }
    return { target, relative: parts.join('/'), content: change.content };
  });
  for (const key of paths) {
    for (let parent = path.dirname(key); parent !== canonical && parent !== path.dirname(parent); parent = path.dirname(parent)) {
      if (paths.has(parent)) throw new Error('同一批变更不能同时把路径用作文件和目录');
    }
  }
  for (const { target, content } of prepared) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  return { summary: payload.summary, files: prepared.map((change) => change.relative) };
}

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
  constructor({ exe, cwd, instructions, sessionId, started = false, model = '', effort = '', forkFrom = null, name = '', writableRoot = null, isolateTools = false, discussionArgs = null, spawnProcess = spawn }) {
    if (writableRoot !== null) {
      if (!path.isAbsolute(cwd) || !path.isAbsolute(writableRoot) || !fs.statSync(writableRoot).isDirectory()
        || fs.realpathSync(cwd) !== fs.realpathSync(writableRoot)) throw new Error('执行目录必须是同一个绝对工作区路径');
      if (started || forkFrom) throw new Error('可写执行必须使用全新对话');
      cwd = fs.realpathSync(writableRoot);
    }
    this.exe = exe;
    this.cwd = cwd;
    this.writableRoot = writableRoot === null ? null : cwd;
    this.spawnProcess = spawnProcess;
    this.isolateTools = isolateTools || writableRoot !== null;
    this.discussionArgs = this.isolateTools ? null : discussionArgs; // 执行会话永远只读
    this.instructions = instructions + (this.writableRoot ? FILE_CHANGE_INSTRUCTIONS : '');
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
    // 完整文件内容不逐字刷屏，校验保存后才播报结果。
    const callbacks = this.writableRoot ? { ...cb, onDelta: undefined } : cb;
    if (this.writableRoot) text += '\n' + FILE_CHANGE_INSTRUCTIONS;
    let res = await this.#run(text, callbacks, this.started ? 'resume' : this.forkFrom ? 'fork' : 'new');
    // 会话状态和预期不一致时（例如上一轮在建立前就被打断），换一种方式重试一次
    if (res.retryAs && !this.interrupted) res = await this.#run(text, callbacks, res.retryAs);
    if (this.interrupted) return { ...res, status: 'interrupted', text: '' };
    if (res.status === 'completed' || res.sawInit) this.started = true;
    if (this.writableRoot && res.status === 'completed') {
      try {
        const changes = applyClaudeFileChanges(this.writableRoot, res.text);
        res = { ...res, changedFiles: changes.files,
          text: `${changes.summary}\n\n宿主已保存 ${changes.files.length} 个文本文件。Claude 受限执行仅支持新增/覆盖文件，未运行命令或测试。` };
        cb.onDelta?.(res.text);
      } catch (e) { res = { ...res, status: 'failed', error: e.message, text: res.text }; }
    }
    return res;
  }

  interrupt() {
    this.interrupted = true;
    if (!this.proc) return;
    this.proc.kill();
  }

  #run(text, cb, mode) {
    return new Promise((resolve) => {
      const tools = this.discussionArgs?.() ?? { args: READ_ONLY_ARGS, env: {} };
      const args = [
        '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        ...tools.args,
        ...(this.isolateTools ? ['--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands'] : []),
        '--append-system-prompt', this.instructions,
        ...(mode === 'resume' ? ['--resume', this.sessionId]
          : mode === 'fork' ? ['--resume', this.forkFrom, '--fork-session', '--session-id', this.sessionId]
          : ['--session-id', this.sessionId]),
        ...(mode !== 'resume' && this.name ? ['--name', this.name] : []),
        ...(this.model ? ['--model', this.model] : []),
        ...(this.effort ? ['--effort', this.effort] : []),
      ];
      this.interrupted = false;
      const p = this.spawnProcess(this.exe, args, { cwd: this.cwd, env: { ...cleanEnv(), ...tools.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
        if (result && !result.is_error) return resolve({ status: 'completed', text: String(result.result ?? '').trim(), sawInit, modelId, usage: normUsage(result.usage) });
        const err = spawnError?.message || result?.result || stderr.trim() || `Claude 进程退出（${code}）`;
        if (!sawInit && mode === 'resume' && /no conversation found|not found/i.test(err)) return resolve({ retryAs: 'new' });
        if (!sawInit && mode !== 'resume' && /already in use|already exists/i.test(err)) return resolve({ retryAs: 'resume' });
        resolve({ status: 'failed', text: '', error: err.slice(0, 500), sawInit });
      });
      p.stdin.end(text, 'utf8');
    });
  }
}

// 统一成 { input（含缓存）, cached（读缓存）, output }
function normUsage(u) {
  if (!u) return null;
  const cached = u.cache_read_input_tokens ?? 0;
  return { input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached, cached, output: u.output_tokens ?? 0 };
}

function toolLabel(block) {
  const i = block.input ?? {};
  switch (block.name) {
    case 'Read': return `读取：${short(i.file_path)}`;
    case 'Grep': return `搜索：${i.pattern ?? ''}${i.path ? ' @ ' + short(i.path) : ''}`;
    case 'Glob': return `查找文件：${i.pattern ?? ''}`;
    case 'Bash': return `运行命令：${short(i.command)}`;
    case 'WebSearch': return `网页搜索：${i.query ?? ''}`;
    case 'WebFetch': return `读取网页：${short(i.url)}`;
    default: return `使用工具：${block.name}`;
  }
}

function short(p) {
  p = String(p ?? '');
  return p.length > 70 ? '…' + p.slice(-69) : p;
}
