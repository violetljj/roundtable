// 读取 Claude / Codex 桌面端的项目和已有对话（只读，不修改任何东西）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

const winPath = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '');
const key = (p) => winPath(p).toLowerCase();

// Claude 把项目路径里的非字母数字字符都换成 '-'，作为存放对话的文件夹名
const claudeDirFor = (p) => path.join(CLAUDE_PROJECTS, winPath(p).replace(/[^a-zA-Z0-9]/g, '-'));

// 临时工作区、主目录这类不算项目
function isRealProject(p) {
  const k = key(p);
  if (!k || k === key(HOME)) return false;
  if (k.includes('\\scratch-workspaces\\') || k.includes('\\appdata\\') || k.includes('\\windowsapps\\')) return false;
  // Codex 桌面端：每个临时任务一个日期文件夹、默认工作区、内部目录，都不算项目
  if (/\\documents\\codex(\\|$)/.test(k) || k.includes('\\.codex\\') || k.includes('\\.claude\\')) return false;
  return true;
}

export async function listProjects(codexServer) {
  const map = new Map();
  const add = (p, source) => {
    if (!isRealProject(p) || !fs.existsSync(p)) return;
    const k = key(p);
    if (!map.has(k)) map.set(k, { path: winPath(p), sources: new Set() });
    const e = map.get(k);
    // Codex 的 config.toml 里路径是全小写的，优先用带原始大小写的写法
    if (e.path === e.path.toLowerCase() && winPath(p) !== winPath(p).toLowerCase()) e.path = winPath(p);
    e.sources.add(source);
  };
  // Claude：~/.claude.json 里记录的项目
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    for (const p of Object.keys(cj.projects ?? {})) add(p, 'claude');
  } catch {}
  // Codex：config.toml 里的 [projects.'...']，以及最近对话的工作目录
  try {
    const toml = fs.readFileSync(path.join(HOME, '.codex', 'config.toml'), 'utf8');
    for (const m of toml.matchAll(/^\[projects\.(?:'([^']+)'|"([^"]+)")\]/gm)) add(m[1] ?? m[2], 'codex');
  } catch {}
  try {
    for (const cwd of await codexServer.allThreadCwds()) add(cwd, 'codex');
  } catch {}
  // 上级目录已经是项目的子文件夹（比如自动生成的 runs\...\execution_repo）不单独列出；Claude 用过的除外
  for (const [k, e] of [...map]) {
    if (e.sources.has('claude')) continue;
    if ([...map.keys()].some((other) => other !== k && k.startsWith(other + '\\'))) map.delete(k);
  }
  // 盘符统一大写，E:\xx 和 e:\xx 显示一致
  for (const e of map.values()) e.path = e.path.replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':');
  return [...map.values()].map((p) => ({ ...p, sources: [...p.sources], ...projectContext(p.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// 项目里有哪些会被自动带入的上下文
export function projectContext(p) {
  const memDir = path.join(claudeDirFor(p), 'memory');
  let memories = 0;
  try { memories = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length; } catch {}
  return {
    claudeMd: fs.existsSync(path.join(p, 'CLAUDE.md')) || fs.existsSync(path.join(p, '.claude', 'CLAUDE.md')),
    agentsMd: fs.existsSync(path.join(p, 'AGENTS.md')),
    claudeMemories: memories,
  };
}

// 列出某个项目下的 Claude 对话（桌面端 Code 标签页和命令行的都在这里）
export function listClaudeSessions(p) {
  const dir = claudeDirFor(p);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files
    .map((f) => { const full = path.join(dir, f); return { id: f.slice(0, -6), full, mtime: fs.statSync(full).mtimeMs }; })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 40)
    .map((s) => ({ id: s.id, title: sessionTitle(s.full), updatedAt: s.mtime }))
    .filter((s) => s.title && !s.title.startsWith('【阶段】') && !s.title.startsWith('圆桌：'))
    .slice(0, 30);
}

function sessionTitle(file) {
  // 文件可能有几 MB，只读开头一段
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n).toString('utf8');
  } catch { return null; }
  let firstUser = null;
  for (const line of head.split('\n')) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'custom-title' && m.customTitle) return m.customTitle;
    if (m.type === 'summary' && m.summary) return m.summary;
    if (!firstUser && m.type === 'user' && !m.isMeta) {
      const c = m.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : null;
      if (text && !text.startsWith('<')) firstUser = text.replace(/\s+/g, ' ').slice(0, 60);
    }
  }
  return firstUser;
}
