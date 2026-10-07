#!/usr/bin/env node
import fs from 'node:fs/promises';
import { RoundtableClient, RoundtableError } from '../lib/roundtable-client.js';

const usage = `圆桌入口（不调用客户端内部会话接口）
  node scripts/roundtable.js start --input <UTF-8 JSON文件> [--wait] [--timeout 60] [--url http://127.0.0.1:4545]
  node scripts/roundtable.js result --id <讨论ID> [--url ...]
  node scripts/roundtable.js wait --id <讨论ID> [--timeout 60] [--url ...]
输出为 JSON；退出码 0=成功/仍在运行，2=需要用户处理，3=等待到时，1=输入或请求失败。
停止此客户端只结束等待，不停止共享讨论。`;

let current;
let client;
let command;
try {
  const args = process.argv.slice(2);
  command = args.shift();
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(usage);
  } else {
    if (!['start', 'result', 'wait'].includes(command)) throw new RoundtableError('未知命令，使用 --help 查看用法', 'INVALID_INPUT');
    const options = {};
    const allowed = new Set(command === 'start' ? ['input', 'wait', 'timeout', 'url'] : command === 'wait' ? ['id', 'timeout', 'url'] : ['id', 'url']);
    while (args.length) {
      const flag = args.shift();
      const key = flag.startsWith('--') ? flag.slice(2) : '';
      if (!allowed.has(key) || options[key] !== undefined) throw new RoundtableError(`未知或重复参数：${flag}`, 'INVALID_INPUT');
      if (key === 'wait') options[key] = true;
      else {
        const value = args.shift();
        if (!value || value.startsWith('--')) throw new RoundtableError(`${flag} 缺少值`, 'INVALID_INPUT');
        options[key] = value;
      }
    }
    const timeoutMs = Number(options.timeout ?? 60) * 1000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 3600000) throw new RoundtableError('timeout 必须大于 0 且不超过 3600 秒', 'INVALID_INPUT');
    client = new RoundtableClient({ url: options.url });
    if (command === 'start') {
      if (!options.input) throw new RoundtableError('start 需要 --input 文件', 'INVALID_INPUT');
      const text = await fs.readFile(options.input, 'utf8');
      current = await client.start(JSON.parse(text.replace(/^\uFEFF/, '')));
      // 先输出 ID，即使之后断开，也能取回原讨论而不重复创建。
      if (options.wait) process.stderr.write(`${JSON.stringify(current)}\n`);
    } else {
      if (!options.id) throw new RoundtableError(`${command} 需要 --id`, 'INVALID_INPUT');
      current = { id: options.id, url: client.roomUrl(options.id) };
    }
    if (command === 'wait' || options.wait) current = await client.wait(current.id, { timeoutMs });
    else if (command === 'result') current = await client.result(current.id);
    console.log(JSON.stringify(current, null, 2));
    if (current.state === 'needs_attention') process.exitCode = 2;
    if (current.state === 'timeout') process.exitCode = 3;
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, code: error.code ?? 'ERROR', ...current,
    nextAction: current?.id ? '讨论未被取消；打开链接检查，稍后用同一 ID 取回结果。'
      : command === 'start' ? '先检查讨论室列表是否已创建本场，再决定是否重试，避免重复消耗额度。' : '检查输入、服务地址和服务版本。' }, null, 2));
  process.exitCode = 1;
}
