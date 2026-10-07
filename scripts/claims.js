import { FileClaims } from '../lib/file-claims.js';

const help = `文件认领（路径始终相对于仓库根目录）
  node scripts/claims.js claim --owner Codex --task "修改讨论面板" --minutes 60 public/app.js
  node scripts/claims.js list
  node scripts/claims.js renew --owner Codex --token <认领凭据> --minutes 60 public/app.js
  node scripts/claims.js release --owner Codex --token <认领凭据> public/app.js
可选：--repo <仓库路径>。所有命令输出 JSON，错误退出码为 1。
预计到期仅提示失联，不会自动释放；请保存 claim 返回的 token。`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(help); return; }
  if (!['claim', 'list', 'renew', 'release'].includes(command)) throw new Error(`未知命令：${command}\n${help}`);
  const values = {}; const files = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { files.push(...args.slice(index + 1)); break; }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!['repo', 'owner', 'task', 'minutes', 'token'].includes(name) || values[name] !== undefined) throw new Error(`未知或重复选项：${arg}`);
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`选项缺少值：${arg}`);
      values[name] = args[++index];
    } else files.push(arg);
  }
  const store = new FileClaims(values.repo);
  const result = command === 'list' ? await store.list() : await store[command]({ files, owner: values.owner, task: values.task, token: values.token, ttlMinutes: values.minutes });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(JSON.stringify({ error: error.code || 'ERROR', message: error.message })); process.exitCode = 1; });
