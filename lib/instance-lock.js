// 同一个讨论记录目录只允许一份服务：两份会同时写 rooms/，后启动的一份还会把前一份的 Codex 后台当残留进程清理掉。
// 锁文件记录占用者的 PID 和端口；第二份启动时找到它就直接打开已有页面。
import fs from 'node:fs';
import path from 'node:path';

const PORT_SPAN = 10; // 与 server.js 端口被占用时的顺延范围一致

export const lockPath = (roomsDir) => path.join(roomsDir, '.server.json');

export function readLock(roomsDir) {
  try { return JSON.parse(fs.readFileSync(lockPath(roomsDir), 'utf8')); } catch { return null; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export async function probeRoundtable(port, timeoutMs = 1500) {
  if (!port) return false;
  const data = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return !!data && 'claudeExe' in data && 'codex' in data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 返回 { port } 表示已有讨论室在运行；返回 null 表示本进程取得了锁
export async function claimInstance(roomsDir, { basePort, probe = probeRoundtable, alive = pidAlive, startupWaitMs = 15000, pollMs = 500 } = {}) {
  const file = lockPath(roomsDir);
  for (let attempt = 0; attempt < 3; attempt++) {
    const owner = readLock(roomsDir);
    if (owner && owner.pid !== process.pid && alive(owner.pid)) {
      // 对方可能刚启动、还没开始监听，等它一会儿；一直不应答多半是 PID 被系统复用了，按失效处理
      const deadline = Date.now() + startupWaitMs;
      for (;;) {
        const port = readLock(roomsDir)?.port;
        if (await probe(port)) return { port };
        if (Date.now() >= deadline || !alive(owner.pid)) break;
        await sleep(pollMs);
      }
    }
    if (!owner) {
      // 没有锁文件的旧版服务：在顺延范围内找一遍
      for (let port = basePort; port <= basePort + PORT_SPAN; port++) if (await probe(port, 400)) return { port };
    }
    // 删之前再确认还是同一份失效锁，避免删掉另一个新启动者刚写的锁
    const now = readLock(roomsDir);
    if (owner && now && now.pid === owner.pid && now.startedAt === owner.startedAt) fs.rmSync(file, { force: true });
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: null, startedAt: Date.now() }), { flag: 'wx' });
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // 另一份恰好同时启动：重新读一遍
    }
  }
  throw new Error('另一份讨论室正在启动，请几秒后再试');
}

export function updateInstance(roomsDir, fields) {
  const lock = readLock(roomsDir);
  if (lock?.pid !== process.pid) return;
  fs.writeFileSync(lockPath(roomsDir), JSON.stringify({ ...lock, ...fields }));
}

export function releaseInstance(roomsDir) {
  if (readLock(roomsDir)?.pid === process.pid) fs.rmSync(lockPath(roomsDir), { force: true });
}
