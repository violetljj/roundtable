import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function label(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail('INVALID_INPUT', `${name}不能为空，且不能超过 1000 字符`);
  return value.trim();
}
function minutes(value = 60) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10080) fail('INVALID_INPUT', '预计时长须大于 0 且不超过 10080 分钟');
  return n;
}
function noLink(file) {
  try { if (fs.lstatSync(file).isSymbolicLink()) fail('UNSAFE_PATH', `不允许链接路径：${file}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export class FileClaims {
  constructor(cwd = process.cwd()) {
    const git = (...args) => execFileSync('git', ['-C', cwd, 'rev-parse', ...args], { encoding: 'utf8', windowsHide: true }).trim();
    this.root = fs.realpathSync(git('--show-toplevel'));
    this.directory = path.join(fs.realpathSync(git('--path-format=absolute', '--git-common-dir')), 'roundtable-claims');
    noLink(this.directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.registry = path.join(this.directory, 'claims.json');
    this.lock = path.join(this.directory, 'write.lock');
  }

  normalize(file) {
    if (typeof file !== 'string' || !file || /[\x00-\x1f:*?"<>|]/.test(file) || path.win32.isAbsolute(file) || path.posix.isAbsolute(file)) {
      fail('UNSAFE_PATH', '请使用仓库根目录下的相对文件路径');
    }
    const parts = file.replaceAll('\\', '/').split('/').filter((part) => part !== '.' && part !== '');
    if (!parts.length || parts.some((part) => part === '..' || /[. ]$/.test(part) || part.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
      fail('UNSAFE_PATH', `不安全的文件路径：${file}`);
    }
    let current = this.root;
    for (const part of parts) { current = path.join(current, part); noLink(current); }
    if (fs.existsSync(current) && fs.statSync(current).isDirectory()) fail('UNSAFE_PATH', '请认领具体文件，不要认领目录');
    const normalized = parts.join('/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  #files(files) {
    if (!Array.isArray(files) || !files.length) fail('INVALID_INPUT', '至少指定一个文件');
    return [...new Set(files.map((file) => this.normalize(file)))];
  }

  async #transaction(update) {
    const deadline = Date.now() + 5000;
    for (;;) {
      noLink(this.directory);
      try { fs.mkdirSync(this.lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) fail('LOCK_BUSY', `认领登记正在使用，或上次进程异常退出；确认没有认领命令运行后检查 ${this.lock}。不会自动抢锁。`);
        await delay(25);
      }
    }
    let temporary;
    try {
      noLink(this.registry);
      const data = fs.existsSync(this.registry) ? JSON.parse(fs.readFileSync(this.registry, 'utf8')) : [];
      if (!Array.isArray(data) || data.some((row) => !row || typeof row.file !== 'string' || typeof row.token !== 'string' || typeof row.owner !== 'string')) fail('INVALID_REGISTRY', '认领记录损坏，已停止写入');
      const { result, next } = update(data);
      if (next) {
        temporary = path.join(this.directory, `${randomUUID()}.tmp`);
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
        fs.renameSync(temporary, this.registry);
        temporary = null;
      }
      return result;
    } finally {
      if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.rmdirSync(this.lock);
    }
  }

  claim({ files, owner, task, ttlMinutes = 60 }) {
    const targets = this.#files(files);
    owner = label(owner, '持有者'); task = label(task, '任务');
    const ttl = minutes(ttlMinutes);
    return this.#transaction((data) => {
      const conflicts = data.filter((row) => targets.includes(row.file));
      if (conflicts.length) fail('CLAIM_CONFLICT', `文件已被认领（超时也不自动释放）：${conflicts.map((row) => `${row.file} → ${row.owner}（${row.task}）`).join('；')}`);
      const now = new Date();
      const token = randomUUID();
      const records = targets.map((file) => ({ file, owner, task, token, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 60000).toISOString() }));
      return { result: { token, claims: records }, next: [...data, ...records] };
    });
  }

  list() {
    return this.#transaction((data) => ({ result: data.map(({ token, ...row }) => ({ ...row, stale: Date.parse(row.expiresAt) <= Date.now() })) }));
  }

  #change({ files, owner, token, ttlMinutes = 60 }, release) {
    const targets = this.#files(files);
    owner = label(owner, '持有者'); token = label(token, '认领凭据');
    const ttl = minutes(ttlMinutes);
    return this.#transaction((data) => {
      for (const file of targets) {
        const row = data.find((entry) => entry.file === file);
        if (!row || row.owner !== owner || row.token !== token) fail('NOT_OWNER', `未找到与持有者及凭据匹配的认领：${file}`);
      }
      const now = new Date();
      const next = release ? data.filter((row) => !targets.includes(row.file)) : data.map((row) => targets.includes(row.file) ? { ...row, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 60000).toISOString() } : row);
      return { result: { files: targets, released: release }, next };
    });
  }

  renew(options) { return this.#change(options, false); }
  release(options) { return this.#change(options, true); }
}
