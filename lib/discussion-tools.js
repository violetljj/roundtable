// 讨论期间可放开的能力（全局设置，所有讨论共用）。
// 原则：讨论仍不改项目文件。能硬性限制的靠工具配置限制，不靠提示词：
// Claude 用 dontAsk 权限模式，只有白名单里的工具和命令能执行，其余一律自动拒绝；
// Codex 仍是只读沙盒，联网搜索和插件不受沙盒限制，插件全开是用户明确接受的取舍。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const DISCUSSION_TOOL_KEYS = ['web', 'claudeShell', 'claudeDocs', 'codexPlugins'];
const DEFAULTS = { web: true, claudeShell: true, claudeDocs: true, codexPlugins: true };

const file = (roomsDir) => path.join(roomsDir, '.discussion-tools.json');

export function normalizeDiscussionTools(input) {
  const out = {};
  for (const key of DISCUSSION_TOOL_KEYS) out[key] = typeof input?.[key] === 'boolean' ? input[key] : DEFAULTS[key];
  return out;
}

export function loadDiscussionTools(roomsDir) {
  try { return normalizeDiscussionTools(JSON.parse(fs.readFileSync(file(roomsDir), 'utf8'))); } catch { return { ...DEFAULTS }; }
}

export function saveDiscussionTools(roomsDir, settings) {
  const normalized = normalizeDiscussionTools(settings);
  fs.writeFileSync(file(roomsDir), JSON.stringify({ ...normalized, savedAt: Date.now() }, null, 2));
  return normalized;
}

// Windows 上 Claude 默认的命令工具是 PowerShell，它的前缀白名单在本机解析失败、永远匹配不上；
// Git Bash 的命令由 Claude Code 自己解析，重定向、管道、&& 拼接都会按整条命令判定。
export function findGitBash(env = process.env) {
  if (env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH;
  if (process.platform !== 'win32') return null;
  try {
    const gits = execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).split(/\r?\n/).filter(Boolean);
    for (const git of gits) {
      // git.exe 在 <Git>\cmd 或 <Git>\mingw64\bin 下，bash 在 <Git>\bin
      for (const up of ['..', '../..']) {
        const bash = path.resolve(path.dirname(git), up, 'bin', 'bash.exe');
        if (fs.existsSync(bash)) return bash;
      }
    }
  } catch {}
  return null;
}

// Codex 的 exa 未登录会被免费额度限流，有 EXA_API_KEY 时用它。用户用 setx 刚设的变量，
// 已在运行的进程看不到，从注册表补上，免得非要重新登录才生效。key 只经环境变量进请求头，不进 URL 和命令行。
export function syncExaKey(env = process.env) {
  if (env.EXA_API_KEY) return true;
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'EXA_API_KEY'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const key = out.match(/EXA_API_KEY\s+REG_(?:EXPAND_)?SZ\s+(\S+)/i)?.[1];
    if (key) { env.EXA_API_KEY = key; return true; }
  } catch {}
  return false;
}

// 只读命令白名单。不放 find（-delete/-exec）、rg（--pre 会执行命令）、git grep（-O 会打开程序）、git branch（带参数会建分支）。
const READ_ONLY_COMMANDS = [
  'git log', 'git show', 'git diff', 'git status', 'git blame', 'git ls-files', 'git rev-parse', 'git branch --show-current',
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd',
];
// 白名单只匹配前缀，挡不住参数中间的写出选项：git log/show/diff 都接受 --output=文件，实测会真的写文件。
const DENIED_COMMANDS = ['Bash(*--output*)', 'Bash(*--ext-diff*)'];
const CLAUDE_DOCS_READ = ['read', 'query', 'guide'].map((t) => `mcp__claude_ai_Claude_Docs__${t}`);

// 返回讨论会话的 Claude 工具参数。没有任何放开时与原来的纯只读参数一致。
export function claudeDiscussionArgs(settings, gitBash) {
  const s = normalizeDiscussionTools(settings);
  const tools = ['Read', 'Grep', 'Glob'];
  const allowed = [];
  if (s.web) { tools.push('WebSearch', 'WebFetch'); allowed.push('WebSearch', 'WebFetch', 'mcp__plugin_exa_exa'); }
  const shell = s.claudeShell && gitBash;
  if (shell) { tools.push('Bash'); allowed.push(...READ_ONLY_COMMANDS.map((c) => `Bash(${c}:*)`)); }
  if (s.claudeDocs) allowed.push(...CLAUDE_DOCS_READ);
  if (!allowed.length) return { args: ['--tools', tools.join(','), '--strict-mcp-config', '--permission-mode', 'default'], env: {} };
  const mcp = s.web || s.claudeDocs;
  return {
    args: [
      '--tools', tools.join(','), ...(mcp ? [] : ['--strict-mcp-config']),
      '--permission-mode', 'dontAsk', '--allowedTools', allowed.join(','),
      ...(shell ? ['--disallowedTools', DENIED_COMMANDS.join(',')] : []),
    ],
    env: shell ? { CLAUDE_CODE_GIT_BASH_PATH: gitBash } : {},
  };
}

// 讨论用 Codex app-server 的启动参数。钩子和电脑操控功能始终关闭；
// 关插件时保留 --disable plugins，旧版本据此识别并清理自己留下的进程。
// 注意：逐个插件 -c plugins."x".enabled=false 实测不生效，所以只能整体开或关。
export function codexDiscussionArgs(settings, { exaKey = false } = {}) {
  const s = normalizeDiscussionTools(settings);
  const off = ['hooks', 'computer_use'];
  if (!s.codexPlugins) off.push('plugins', 'apps', 'browser_use', 'browser_use_external', 'in_app_browser');
  return [
    ...off.flatMap((f) => ['--disable', f]),
    '-c', `web_search="${s.web ? 'live' : 'disabled'}"`,
    ...(s.web ? ['-c', 'mcp_servers.exa.url="https://mcp.exa.ai/mcp"'] : []),
    ...(s.web && exaKey ? ['-c', 'mcp_servers.exa.env_http_headers={ "x-api-key" = "EXA_API_KEY" }'] : []),
  ];
}
