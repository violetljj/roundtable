// Claude × Codex 讨论室：本地网页服务器。只监听 127.0.0.1。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexServer } from './lib/codex.js';
import { findClaudeExe, claudeAccount, claudeEvents, probeClaudeLimits, CLAUDE_MODELS, CLAUDE_EFFORTS, prettyClaudeModel, resolveClaudeAlias, loadResolvedClaudeModels, resolvedClaudeModels } from './lib/claude.js';
import { Room } from './lib/room.js';
import { BEHAVIOR_PRESETS, loadBehaviorDefaults, saveBehaviorDefaults, inheritBehaviorCards } from './lib/behavior-cards.js';
import { listProjects, listClaudeSessions, projectContext } from './lib/desktop.js';
import { Handoff } from './lib/handoff.js';
import { createExecutionAgentFactory } from './lib/execution-agents.js';
import { previewSource } from './lib/source-reference.js';
import { Experiment } from './lib/experiment.js';
import { roomResult, experimentAction, assertDiscussionAvailable } from './lib/discussion-api.js';
import { createStatusCache } from './lib/status-cache.js';
import { claimInstance, updateInstance, releaseInstance } from './lib/instance-lock.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOMS_DIR = process.env.ROUNDTABLE_ROOMS_DIR ? path.resolve(process.env.ROUNDTABLE_ROOMS_DIR) : path.join(ROOT, 'rooms');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BASE_PORT = parseInt(process.env.ROUNDTABLE_PORT ?? '4545', 10);

fs.mkdirSync(ROOMS_DIR, { recursive: true });

// 同一个讨论记录目录只跑一份服务；已有的话直接打开它（规则见 lib/instance-lock.js）
let existing;
try {
  existing = await claimInstance(ROOMS_DIR, { basePort: BASE_PORT });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (existing) {
  const url = `http://127.0.0.1:${existing.port}`;
  console.log(`讨论室已经在运行：${url}，不再重复启动。`);
  if (process.argv.includes('--open')) await new Promise((resolve) => exec(`start "" "${url}"`, resolve));
  process.exit(0);
}
process.on('exit', () => releaseInstance(ROOMS_DIR));
// 窗口标题在这里设：.cmd 里写中文标题会因为代码页切换被读成乱码命令
process.title = '圆桌讨论室（关闭此窗口即停止）';

const claudeExe = findClaudeExe();
const codexServer = new CodexServer({ pidFile: path.join(ROOMS_DIR, '.codex-app-server.pid') });
codexServer.on('stderr', (s) => { if (/error|panic/i.test(s)) console.error('[codex]', s.trim().slice(0, 300)); });
// 写定稿交给当前额度用得更少的一方；数据过期或缺失时交给复核方
function pickFinalizer(reviewer) {
  const now = Date.now() / 1000;
  const live = (w) => (w && (!w.resetsAt || w.resetsAt > now) ? w : null);
  const cw = status.claude.limits?.unifiedWindows ?? {};
  const claudeWins = [live(cw.five_hour), live(cw.seven_day)].filter(Boolean);
  const claudeUse = claudeWins.length ? Math.max(...claudeWins.map((w) => w.utilization)) : null;
  const rl = status.codex.rateLimits;
  const codexWins = [live(rl?.primary), live(rl?.secondary)].filter(Boolean);
  const codexUse = codexWins.length ? Math.max(...codexWins.map((w) => w.usedPercent / 100)) : null;
  if (claudeUse == null || codexUse == null) return reviewer;
  if (Math.abs(claudeUse - codexUse) < 0.1) return reviewer;
  return claudeUse < codexUse ? 'claude' : 'codex';
}
const ctx = { roomsDir: ROOMS_DIR, codexServer, claudeExe, pickFinalizer };
const executionAgentFactory = createExecutionAgentFactory({ codexServer, claudeExe });

// ---------- 账号与额度 ----------
// Claude 的额度只能在发言时由命令行顺带报告，所以缓存到磁盘，重启后仍能显示上一次的数据
const STATUS_FILE = path.join(ROOMS_DIR, '.claude-limits.json');
const status = {
  claude: { account: null, limits: readJson0(STATUS_FILE), probing: false },
  codex: { account: null, rateLimits: null },
};
claudeEvents.on('rateLimit', (info) => {
  status.claude.limits = { ...info, at: Date.now() };
  try { fs.writeFileSync(STATUS_FILE, JSON.stringify(status.claude.limits), 'utf8'); } catch {}
});
// Claude 别名实际对应的型号：每次发言都会更新，存盘以便重启后仍显示具体版本
const MODELS_FILE = path.join(ROOMS_DIR, '.claude-models.json');
loadResolvedClaudeModels(readJson0(MODELS_FILE));
claudeEvents.on('model', () => {
  try { fs.writeFileSync(MODELS_FILE, JSON.stringify(resolvedClaudeModels()), 'utf8'); } catch {}
});
codexServer.on('account', (method, p) => {
  if (method === 'account/rateLimits/updated' && p.rateLimits) status.codex.rateLimits = p.rateLimits;
});

const claudeStatus = createStatusCache({
  ttlMs: 60000,
  load: async () => {
    const account = await claudeAccount(claudeExe);
    if (account.error) throw new Error(account.error);
    return account;
  },
  onValue: (account) => { status.claude.account = account; },
});
const codexStatus = createStatusCache({
  ttlMs: 30000,
  load: async () => {
    await codexServer.start();
    // account() 会把 RPC 失败吞成 null；缓存必须区分查询失败和确实未登录。
    const [account, limits] = await Promise.all([
      codexServer.request('account/read', { refreshToken: false }),
      codexServer.request('account/rateLimits/read', {}),
    ]);
    return { account: account.account, rateLimits: limits.rateLimits };
  },
  onValue: (result) => {
    status.codex.account = result.account;
    if (result.rateLimits) status.codex.rateLimits = result.rateLimits;
  },
});

function getStatus(force = false) {
  if (force) {
    if (claudeExe) void claudeStatus.refresh(true);
    void codexStatus.refresh(true);
  }
  const claude = claudeExe ? claudeStatus.read() : { refreshing: false, updatedAt: null, error: '找不到 Claude 命令行' };
  const codex = codexStatus.read();
  return {
    claude: { ...status.claude, refreshing: claude.refreshing, updatedAt: claude.updatedAt, error: claude.error },
    codex: { ...status.codex, refreshing: codex.refreshing, updatedAt: codex.updatedAt, error: codex.error },
  };
}

let modelsCache = null;
let projectsCache = null;
async function getModels() {
  if (!modelsCache) {
    const codex = await codexServer.models().catch(() => []);
    modelsCache = { codex: { models: codex } };
    if (!codex.length) setTimeout(() => { modelsCache = null; }, 5000);
  }
  // Claude 的具体版本随时可能更新，每次现算
  const claude = CLAUDE_MODELS.map((m) => {
    const version = prettyClaudeModel(resolveClaudeAlias(m.id));
    return { ...m, version, name: m.id ? (version || m.name) : `命令行默认${version ? `（${version}）` : ''}` };
  });
  return { ...modelsCache, claude: { models: claude, efforts: CLAUDE_EFFORTS } };
}

function readJson0(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const rooms = new Map();
for (const name of fs.readdirSync(ROOMS_DIR)) {
  const dir = path.join(ROOMS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'state.json'))) continue;
  try { register(Room.load(dir, ctx)); } catch (e) { console.error('无法载入讨论室', name, e.message); }
}

const clients = new Map(); // roomId -> Set<res>
function register(room) {
  rooms.set(room.d.id, room);
  room.handoff = new Handoff(room, { agentFactory: executionAgentFactory });
  room.experiment = new Experiment(room, { agentFactory: executionAgentFactory });
  room.on('event', (ev) => {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients.get(room.d.id) ?? []) res.write(data);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let port = BASE_PORT;
const server = http.createServer(async (req, res) => {
  // 防止其他网站通过浏览器访问本地服务
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(full).pipe(res);
    }

    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) return send(res, 415, { error: 'json only' });

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let codex = 'ok';
      try { await codexServer.start(); } catch (e) { codex = e.message; }
      return send(res, 200, { claude: claudeExe ? 'ok' : '找不到 Claude 命令行（claude.exe）', claudeExe, codex, cwd: ROOT });
    }

    if (req.method === 'GET' && url.pathname === '/api/models') return send(res, 200, await getModels());
    if (req.method === 'GET' && url.pathname === '/api/behavior-cards') {
      // 型号建议用完整 ID：行为卡按完整型号精确匹配
      const codex = (await getModels()).codex?.models ?? [];
      const modelChoices = { claude: [...new Set(Object.values(resolvedClaudeModels()))], codex: codex.map((m) => m.id) };
      return send(res, 200, { defaults: loadBehaviorDefaults(ROOMS_DIR), presets: BEHAVIOR_PRESETS, modelChoices });
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      if (!projectsCache || Date.now() - projectsCache.at > 60000) projectsCache = { at: Date.now(), list: await listProjects(codexServer) };
      return send(res, 200, projectsCache.list);
    }
    // 某个项目下两边已有的对话，以及会自动带入的上下文
    if (req.method === 'GET' && url.pathname === '/api/projects/sessions') {
      const p = url.searchParams.get('path') ?? '';
      if (!p || !fs.existsSync(p)) return send(res, 400, { error: `找不到文件夹：${p}` });
      const [claude, codex] = await Promise.all([
        Promise.resolve(listClaudeSessions(p)),
        codexServer.threadsFor(p).catch(() => []),
      ]);
      return send(res, 200, { claude, codex, context: projectContext(p) });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, getStatus(url.searchParams.get('refresh') === '1'));
    // 主动刷新 Claude 额度：发一条最小的 Haiku 请求，会消耗极少额度
    if (req.method === 'POST' && url.pathname === '/api/status/refresh-claude') {
      if (!claudeExe) return send(res, 500, { error: '找不到 Claude 命令行' });
      if (!status.claude.probing) {
        status.claude.probing = true;
        await probeClaudeLimits(claudeExe).finally(() => { status.claude.probing = false; });
      }
      return send(res, 200, await getStatus());
    }

    // GET/POST /api/rooms
    if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 2) {
      if (req.method === 'GET') return send(res, 200, [...rooms.values()].map((r) => r.summary()).sort((a, b) => b.createdAt - a.createdAt));
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (!body.topic?.trim()) return send(res, 400, { error: '请填写讨论主题' });
        if (!claudeExe) return send(res, 500, { error: '找不到 Claude 命令行' });
        if (body.cwd && !fs.existsSync(body.cwd)) return send(res, 400, { error: `找不到文件夹：${body.cwd}` });
        const requestedBehavior = body.behaviorCards;
        body.behaviorCards = inheritBehaviorCards(requestedBehavior, loadBehaviorDefaults(ROOMS_DIR));
        // 新建时明确开关也算一次修改，之后的讨论沿用
        if (requestedBehavior?.enabled !== undefined) saveBehaviorDefaults(ROOMS_DIR, body.behaviorCards);
        const room = Room.create(body, ctx);
        register(room);
        room.start();
        return send(res, 200, { id: room.d.id });
      }
    }

    const room = parts[0] === 'api' && parts[1] === 'rooms' ? rooms.get(parts[2]) : null;
    if (parts[1] === 'rooms' && !room) return send(res, 404, { error: '讨论室不存在' });

    if (room && req.method === 'GET' && parts.length === 3) return send(res, 200, room.snapshot());

    if (room && req.method === 'GET' && parts.length === 4 && parts[3] === 'result') return send(res, 200, roomResult(room));

    if (room && parts[3] === 'experiment') {
      if (req.method === 'GET' && parts.length === 4) return send(res, 200, room.experiment.snapshot());
      if (req.method === 'POST' && parts.length === 5) {
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: '只允许从讨论室页面操作小实验' });
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: '实验请求必须是对象' });
        try { return send(res, 200, await experimentAction(room, parts[4], body)); }
        catch (error) { return send(res, 409, { error: error.message }); }
      }
      return send(res, 404, { error: '未知的小实验接口' });
    }

    if (room && req.method === 'POST') {
      try {
        assertDiscussionAvailable(room, parts[3]);
        if (parts[3] === 'handoff' && parts[4] === 'start' && room.experiment.d?.status === 'running') throw new Error('请等待或取消正在运行的小实验');
      } catch (error) { return send(res, 409, { error: error.message }); }
    }

    if (room && req.method === 'GET' && parts.length === 4 && parts[3] === 'source') {
      try { return send(res, 200, previewSource(room.d.cwd, url.searchParams.get('reference'))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (room && req.method === 'POST' && parts.length === 4 && ['claims', 'check'].includes(parts[3])) {
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: '只允许从讨论室页面操作核查清单' });
      const body = await readJson(req);
      try {
        if (parts[3] === 'claims') room.updateClaim(body);
        else room.checkClaim(body);
        return send(res, 200, { ok: true });
      } catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (room && parts[3] === 'handoff') {
      if (req.method === 'GET' && parts.length === 4) return send(res, 200, room.handoff.snapshot());
      if (req.method === 'POST' && parts.length === 5) {
        // 执行和合并具有写入权限，只接受同源网页或没有 Origin 的本地客户端。
        if (req.headers.origin && req.headers.origin !== `http://${host}`) return send(res, 403, { error: '只允许从讨论室页面操作执行交接' });
        const actions = { card: 'saveCard', start: 'start', cancel: 'cancel', merge: 'merge', discard: 'discard' };
        const action = actions[parts[4]];
        if (!action) return send(res, 404, { error: '未知的交接操作' });
        const body = await readJson(req);
        try {
          await room.handoff[action](body);
          return send(res, 200, room.handoff.snapshot());
        } catch (e) {
          return send(res, 409, { error: e.message });
        }
      }
      return send(res, 404, { error: '未知的交接接口' });
    }

    if (room && req.method === 'GET' && parts[3] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'snapshot', room: room.snapshot() })}\n\n`);
      if (!clients.has(room.d.id)) clients.set(room.d.id, new Set());
      clients.get(room.d.id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.get(room.d.id)?.delete(res); });
      return;
    }

    if (room && req.method === 'GET' && parts[3] === 'transcript') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="roundtable-${room.d.id}.md"` });
      return fs.createReadStream(path.join(room.dir, 'transcript.md')).pipe(res);
    }

    if (room && req.method === 'POST') {
      const body = await readJson(req);
      switch (parts[3]) {
        case 'message': room.userMessage(body.text, body.target, !!body.urgent); break;
        case 'pause': room.pause(); break;
        case 'resume': room.resume(); break;
        case 'interrupt': room.interrupt(); break;
        case 'finish': room.finish(); break;
        case 'stop': room.stop(); await room.experiment.dispose(); break;
        case 'add-round': room.addRound(); break;
      case 'reopen': if (!room.reopen(body.rounds)) return send(res, 400, { error: '只有讨论已结束、没人在发言时才能重新打开' }); break;
      case 'resummarize': if (!room.resummarize()) return send(res, 400, { error: '只有讨论已结束、没人在发言时才能更新结论' }); break;
        case 'models': room.updateModels(body); break;
        case 'facts': room.updateFacts(body.text); break;
        case 'rename': room.rename(body.title); break;
        case 'settings':
          room.updateSettings(body);
          // 本场改过的卡片组成为之后新讨论的默认值
          if (body.behaviorCards !== undefined) saveBehaviorDefaults(ROOMS_DIR, room.d.behaviorCards);
          break;
        case 'finalize': if (!room.finalize()) return send(res, 400, { error: '这场讨论现在不能生成定稿（需要已结束、有复核、还没有定稿）' }); break;
        default: return send(res, 404, { error: 'unknown action' });
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
});

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < BASE_PORT + 10) { port++; server.listen(port, '127.0.0.1'); return; }
  console.error(e);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  updateInstance(ROOMS_DIR, { port });
  console.log(`讨论室已启动：${url}`);
  console.log(claudeExe ? `Claude 命令行：${claudeExe}` : '警告：找不到 Claude 命令行');
  console.log('关闭这个窗口即可停止服务。');
  if (process.argv.includes('--open')) exec(`start "" "${url}"`);
  // 提前启动 Codex 后台，打开网页时不用等
  codexServer.start().then(() => getModels()).catch((e) => console.error('Codex 启动失败：', e.message));
  getStatus(); // 后台预热账号，页面不等待命令行查询。
});

async function shutdown() {
  server.close();
  await Promise.allSettled([...rooms.values()].map((room) => room.handoff.cancel()));
  await Promise.allSettled([...rooms.values()].map((room) => room.experiment.dispose()));
  codexServer.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // Windows 上直接关掉命令行窗口时收到的是这个
process.on('exit', () => codexServer.stop());
