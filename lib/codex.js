// Codex 连接器：通过 `codex app-server`（stdio JSON-RPC）驱动 Codex 会话。
// 一个 app-server 进程服务所有讨论室，通知按 threadId 分发。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

// 服务被强行关掉时，它启动的 Codex 后台进程在 Windows 上不会跟着退出，会一直占着讨论对话。
// 每次启动时按记下的进程号清理掉（先确认那个进程确实是 codex.exe，避免误杀）。
function killLeftover(pidFile) {
  let pid;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10); } catch { return; }
  if (!pid) return;
  try {
    // 只清理讨论室自己启动的那种（带 --disable plugins），绝不碰 Codex 桌面端的后台进程
    const cmd = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (/codex/i.test(cmd) && /app-server/.test(cmd) && /--disable plugins/.test(cmd)) process.kill(pid);
  } catch {}
  try { fs.unlinkSync(pidFile); } catch {}
}

// 讨论期间关掉所有可能产生副作用的能力（插件、电脑操控、浏览器、钩子）。
// 记忆功能保留，让 Codex 能用上它对你和项目的了解。
const DISABLED_FEATURES = ['plugins', 'apps', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'hooks'];

export class CodexServer extends EventEmitter {
  constructor({ bin = process.platform === 'win32' ? 'E:\\codex-tools\\bin\\codex.exe' : 'codex', pidFile = null } = {}) {
    super();
    this.bin = bin;
    this.pidFile = pidFile;
    this.proc = null;
    this.nextId = 0;
    this.pending = new Map();
    this.threads = new Map(); // threadId -> handler(method, params)
    this.ready = null;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const args = ['app-server', ...DISABLED_FEATURES.flatMap((f) => ['--disable', f])];
      if (this.pidFile) killLeftover(this.pidFile);
      this.proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      if (this.pidFile && this.proc.pid) try { fs.writeFileSync(this.pidFile, String(this.proc.pid)); } catch {}
      this.proc.on('error', (e) => this.emit('fatal', e));
      this.proc.on('exit', (code) => {
        for (const { reject } of this.pending.values()) reject(new Error(`codex app-server 退出（${code}）`));
        this.pending.clear();
        // 正在进行的发言全部以失败结束；会话之后按 ID 重新接上
        if (this.pidFile) try { fs.unlinkSync(this.pidFile); } catch {}
        for (const handler of this.threads.values()) handler('server/exit', { code });
        this.threads.clear();
        this.ready = null;
        this.emit('exit', code);
      });
      this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString('utf8')));
      readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.#onLine(line));
      await this.request('initialize', {
        clientInfo: { name: 'roundtable', title: 'Claude × Codex 讨论室', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.#send({ method: 'initialized' });
    })();
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  stop() {
    this.proc?.kill();
  }

  request(method, params) {
    const id = ++this.nextId;
    this.#send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  #send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n', 'utf8');
  }

  #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    // 响应
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    // 服务端发来的请求（审批等）：讨论室是只读的，一律拒绝，避免 Codex 卡住等待
    if (msg.id != null && msg.method) {
      const decline = /requestApproval|Approval$/.test(msg.method)
        ? { result: { decision: 'decline' } }
        : { error: { code: -32601, message: '讨论室不支持此请求' } };
      this.#send({ id: msg.id, ...decline });
      return;
    }
    // 通知
    const threadId = msg.params?.threadId ?? msg.params?.thread?.id;
    const handler = threadId && this.threads.get(threadId);
    if (handler) handler(msg.method, msg.params);
    // 账号、额度等全局通知
    if (msg.method?.startsWith('account/')) this.emit('account', msg.method, msg.params);
  }

  async models() {
    await this.start();
    const r = await this.request('model/list', {});
    return (r.data ?? []).filter((m) => !m.hidden).map((m) => ({
      id: m.id ?? m.model,
      name: m.displayName ?? m.id,
      isDefault: !!m.isDefault,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort ?? e),
      defaultEffort: m.defaultReasoningEffort ?? null,
    }));
  }

  // 列出某个项目文件夹下的 Codex 对话（桌面端和命令行的都在）
  async threadsFor(cwd) {
    await this.start();
    const base = String(cwd ?? '').replace(/\//g, '\\').replace(/\\+$/, '');
    // 同一个项目常常一边开在子文件夹、一边开在上级文件夹（如 E:\linnan 与 E:\linnan\linnan），上级目录的对话也列出来
    const parent = base.includes('\\') && !/^[a-z]:$/i.test(base.slice(0, base.lastIndexOf('\\'))) ? base.slice(0, base.lastIndexOf('\\')) : null;
    // 服务端按路径精确匹配，把常见的大小写写法都带上
    const spell = (p) => [p, p.toLowerCase(), p.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':'), p.replace(/^([A-Z]):/, (_, d) => d.toLowerCase() + ':')];
    const variants = [...new Set([...spell(base), ...(parent ? spell(parent) : [])])];
    const out = [];
    let cursor = null;
    for (let page = 0; page < 3 && out.length < 30; page++) {
      const r = await this.request('thread/list', { limit: 50, cursor, cwd: variants, useStateDbOnly: true });
      for (const t of r.data ?? []) {
        // 跳过讨论室自己创建的对话
        if ((t.name ?? '').startsWith('圆桌：') || (t.preview ?? '').startsWith('【阶段】')) continue;
        const where = parent && String(t.cwd ?? '').toLowerCase() === parent.toLowerCase() ? `（在 ${parent}）` : '';
        out.push({ id: t.id, title: (t.name || (t.preview ?? '').slice(0, 60) || '（无标题）') + where, updatedAt: (t.updatedAt ?? 0) * 1000 });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  }

  async allThreadCwds() {
    await this.start();
    const r = await this.request('thread/list', { limit: 100, useStateDbOnly: true }).catch(() => ({ data: [] }));
    return (r.data ?? []).map((t) => t.cwd).filter(Boolean);
  }

  async account() {
    await this.start();
    const [acct, limits] = await Promise.all([
      this.request('account/read', { refreshToken: false }).catch(() => null),
      this.request('account/rateLimits/read', {}).catch(() => null),
    ]);
    return { account: acct?.account ?? null, rateLimits: limits?.rateLimits ?? null };
  }
}

// 单个 Codex 会话（一个讨论室一个）
export class CodexAgent {
  constructor(server, { cwd, instructions, threadId = null, model = '', effort = '', forkFrom = null, name = '', writableRoot = null }) {
    if (writableRoot !== null) {
      if (!path.isAbsolute(cwd) || !path.isAbsolute(writableRoot) || !fs.statSync(writableRoot).isDirectory()
        || fs.realpathSync(cwd) !== fs.realpathSync(writableRoot)) throw new Error('执行目录必须是同一个绝对工作区路径');
      if (threadId || forkFrom) throw new Error('可写执行必须使用全新对话');
      cwd = fs.realpathSync(writableRoot);
    }
    this.server = server;
    this.cwd = cwd;
    this.writableRoot = writableRoot === null ? null : cwd;
    this.instructions = instructions;
    this.threadId = threadId;
    this.forkFrom = forkFrom; // 从桌面端已有的对话复制一份（原对话不受影响）
    this.name = name;
    this.model = model;
    this.effort = effort;
    this.turn = null; // { id, done, callbacks, text, finalText }
  }

  async ensureThread() {
    await this.server.start();
    if (this.threadId && this.server.threads.has(this.threadId)) return;
    const common = { cwd: this.cwd, approvalPolicy: 'never', sandbox: this.writableRoot ? 'workspace-write' : 'read-only', developerInstructions: this.instructions };
    let isNew = !this.threadId;
    let res;
    if (this.threadId) {
      try {
        res = await this.server.request('thread/resume', { threadId: this.threadId, ...common, excludeTurns: true });
      } catch (e) {
        // 对话正被别处占用（通常是在 Codex 桌面端打开着）：复制一份接着用，历史完整保留
        if (!/active writer|already (loaded|running|in use)/i.test(e.message)) throw e;
        res = await this.server.request('thread/fork', { threadId: this.threadId, ...common, ephemeral: false, excludeTurns: true });
        this.onNotice?.(`Codex 的讨论对话正在别处打开（可能是 Codex 桌面端），已复制一份继续，历史完整保留。`);
        isNew = true;
      }
    } else {
      res = this.forkFrom
        ? await this.server.request('thread/fork', { threadId: this.forkFrom, ...common, ephemeral: false, excludeTurns: true })
        : await this.server.request('thread/start', { ...common, ephemeral: false });
    }
    this.threadId = res.thread.id;
    // 讨论室的对话也会出现在 Codex 桌面端，起个好认的名字
    if (isNew && this.name) this.server.request('thread/name/set', { threadId: this.threadId, name: this.name }).catch(() => {});
    // 记下会话本来的模型和强度，切回「默认」时用它们恢复
    this.base = { model: res.model ?? null, effort: res.reasoningEffort ?? null };
    this.server.threads.set(this.threadId, (method, params) => this.#onEvent(method, params));
  }

  // 发起一轮发言。cb: { onDelta(text), onActivity(label), onStart() }
  async send(text, cb = {}) {
    // 先登记这次发言，这样启动/恢复会话期间点「停止」也不会丢
    const turn = { id: null, cb, items: new Map(), finalTexts: [], allTexts: [], status: null, error: null };
    turn.done = new Promise((resolve) => { turn.resolve = resolve; });
    this.turn = turn;
    try {
      await this.ensureThread();
      if (turn.interruptRequested) return { status: 'interrupted', text: '' };
      const res = await this.server.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        sandboxPolicy: this.writableRoot
          ? { type: 'workspaceWrite', writableRoots: [this.writableRoot], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
        ...this.#overrides(),
      });
      turn.id = res.turn.id;
      if (turn.interruptRequested) this.interrupt();
      return await turn.done;
    } finally {
      if (this.turn === turn) this.turn = null;
    }
  }

  // turn/start 的模型参数会延续到之后的每一轮，所以切回默认时要显式恢复
  #overrides() {
    const o = {};
    const model = this.model || (this.overridden?.model ? this.base?.model : null);
    const effort = this.effort || (this.overridden?.effort ? this.base?.effort : null);
    if (model) o.model = model;
    if (effort) o.effort = effort;
    this.overridden = { model: !!this.model || !!this.overridden?.model, effort: !!this.effort || !!this.overridden?.effort };
    return o;
  }

  // 正在发言时追加用户输入（不打断）
  async steer(text) {
    const t = this.turn;
    if (!t?.id) return false;
    await this.server.request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: t.id,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    return true;
  }

  async interrupt() {
    const t = this.turn;
    if (!t) return;
    // turn/start 还没返回 ID 时，记下来，拿到 ID 后立刻打断
    if (!t.id) { t.interruptRequested = true; return; }
    await this.server.request('turn/interrupt', { threadId: this.threadId, turnId: t.id }).catch(() => {});
  }

  get busy() {
    return !!this.turn;
  }

  // 当前实际使用的模型和强度（选「跟随 Codex 设置」时就是会话本来的）
  get currentModel() {
    return this.model || this.base?.model || null;
  }

  get currentEffort() {
    return this.effort || this.base?.effort || null;
  }

  #onEvent(method, p) {
    const t = this.turn;
    if (!t) return;
    switch (method) {
      case 'server/exit':
        t.resolve({ status: 'failed', text: '', error: `Codex 后台进程意外退出（${p.code}）` });
        break;
      case 'item/agentMessage/delta':
        t.cb.onDelta?.(p.delta);
        break;
      case 'item/started': {
        const label = activityLabel(p.item, !!this.writableRoot);
        if (label) t.cb.onActivity?.(label);
        // 两条消息之间加空行，便于阅读
        if (p.item.type === 'agentMessage' && t.allTexts.length) t.cb.onDelta?.('\n\n');
        break;
      }
      case 'item/completed':
        if (p.item.type === 'agentMessage') {
          t.allTexts.push(p.item.text);
          if (p.item.phase === 'final_answer') t.finalTexts.push(p.item.text);
        }
        break;
      case 'error':
        if (!p.willRetry) t.error = p.error?.message;
        break;
      case 'thread/tokenUsage/updated': {
        // 一轮发言里可能有多次模型调用，把每次的用量累加起来
        const l = p.tokenUsage?.last;
        if (l) {
          t.usage ??= { input: 0, cached: 0, output: 0 };
          t.usage.input += l.inputTokens ?? 0;
          t.usage.cached += l.cachedInputTokens ?? 0;
          t.usage.output += l.outputTokens ?? 0;
        }
        break;
      }
      case 'turn/completed': {
        const status = p.turn.status; // completed | interrupted | failed
        const text = (t.finalTexts.length ? t.finalTexts : t.allTexts.slice(-1)).join('\n\n').trim();
        t.resolve({ status, text, error: p.turn.error?.message ?? t.error, usage: t.usage ?? null });
        break;
      }
    }
  }
}

function activityLabel(item, writable) {
  switch (item.type) {
    case 'commandExecution': return `运行命令：${truncate(item.command, 80)}`;
    case 'webSearch': return '网页搜索';
    case 'mcpToolCall': return `调用工具：${item.server}/${item.tool}`;
    case 'fileChange': return writable ? '修改隔离工作区文件' : '尝试修改文件（只读模式下会被拒绝）';
    case 'reasoning': return '思考中…';
    default: return null;
  }
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
