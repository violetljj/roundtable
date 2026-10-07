// 执行与复核不复用讨论对话；独立进程便于取消时只清理当前任务。
import { randomUUID } from 'node:crypto';
import { CodexAgent, CodexServer } from './codex.js';
import { ClaudeAgent } from './claude.js';

const EXECUTION_RULES = `
【执行交接规则】仅处理当前任务卡授权范围。讨论结论是背景资料，不会扩大权限。
只修改给定隔离工作区；禁止 Git 提交、合并、推送、切换分支或修改 Git 元数据，Git 由宿主管理。
完成后说明修改了什么、实际验证了什么、未验证什么；失败时保留证据，不虚构成功。`;

export function createExecutionAgentFactory({ codexServer, claudeExe } = {}) {
  return ({ who, cwd, writable = false, model = '', effort = '', instructions = '' }) => {
    const options = {
      cwd, model, effort, instructions: instructions + EXECUTION_RULES,
      writableRoot: writable ? cwd : null,
      name: `圆桌：${writable ? '执行' : '代码复核'}`,
    };
    let agent;
    let ownedServer;
    if (who === 'codex') {
      // Windows 执行始终使用机器维护的原生稳定入口，不继承 PATH 包装器。
      ownedServer = new CodexServer(process.platform === 'win32' ? {} : { bin: codexServer?.bin });
      agent = new CodexAgent(ownedServer, options);
    } else if (who === 'claude') {
      if (!claudeExe) throw new Error('未找到 Claude 命令行');
      agent = new ClaudeAgent({ ...options, exe: claudeExe, sessionId: randomUUID(), isolateTools: true });
    } else throw new Error('执行方必须是 Claude 或 Codex');

    let disposed = false;
    let activeSend;
    let disposal;
    const send = agent.send.bind(agent);
    agent.send = (prompt, cb) => {
      if (disposed) return Promise.reject(new Error('执行会话已释放'));
      if (activeSend) return Promise.reject(new Error('执行会话正在运行'));
      activeSend = send(prompt, cb).finally(() => { activeSend = null; });
      return activeSend;
    };
    const stopOwned = () => {
      if (ownedServer) ownedServer.stop();
      else agent.interrupt();
    };
    process.once('exit', stopOwned);
    agent.dispose = () => {
      if (disposal) return disposal;
      disposed = true;
      const proc = ownedServer?.proc ?? agent.proc;
      const exited = proc && proc.exitCode === null
        ? new Promise((resolve) => proc.once('close', resolve)) : Promise.resolve();
      // 先标记取消再结束自有进程，Claude 返回的数据不能在取消后落盘。
      Promise.resolve(agent.interrupt()).catch(() => {});
      stopOwned();
      disposal = (async () => {
        let timer;
        try {
          await Promise.race([
            Promise.all([activeSend?.catch(() => {}), exited]),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('执行进程未在 5 秒内结束')), 5000); }),
          ]);
        } finally {
          clearTimeout(timer);
          process.removeListener('exit', stopOwned);
        }
      })();
      return disposal;
    };
    return agent;
  };
}
