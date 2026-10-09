// 后台模式：服务在后台运行、不留命令行窗口，讨论室在默认浏览器的普通标签页里打开，页面全部关掉服务就停。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { readLock, probeRoundtable } from './instance-lock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function openInBrowser(url) {
  return new Promise((resolve) => exec(`start "" "${url}"`, { windowsHide: true }, () => resolve()));
}

// 启动脚本调用的前台进程：把服务转到后台，等它就绪（或发现已在运行）后退出，命令行窗口随之关闭。
// 返回退出码；失败时把后台日志打出来，让启动脚本停住给用户看。
export async function launchInBackground({ script, roomsDir, logFile, timeoutMs = 60000 }) {
  const log = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, [script, '--app', '--background'],
    { cwd: path.dirname(script), detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code ?? 1; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // 后台进程发现已有服务时会打开它的页面后正常退出
    if (exitCode !== null) break;
    const lock = readLock(roomsDir);
    if (lock?.pid === child.pid && await probeRoundtable(lock.port)) {
      console.log(`讨论室已在后台启动：http://127.0.0.1:${lock.port}，关闭讨论室页面即停止。`);
      return 0;
    }
    await sleep(300);
  }
  if (exitCode === 0) return 0;
  // 超时的后台进程没有页面可关，不能留着
  if (exitCode === null) try { process.kill(child.pid); } catch {}
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch {}
  console.error(text.trim() || '后台服务没有输出。');
  console.error(exitCode === null ? `等了 ${timeoutMs / 1000} 秒服务仍未就绪。日志：${logFile}` : `后台服务启动失败。日志：${logFile}`);
  return 1;
}
