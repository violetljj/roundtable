import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export class RoundtableError extends Error {
  constructor(message, code = 'REQUEST_FAILED') {
    super(message);
    this.name = 'RoundtableError';
    this.code = code;
  }
}

export function localUrl(value = 'http://127.0.0.1:4545') {
  let url;
  try { url = new URL(value); } catch { throw new RoundtableError('讨论室地址不是有效 URL', 'INVALID_URL'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new RoundtableError('仅支持没有凭证、路径或查询参数的本机 HTTP 地址', 'INVALID_URL');
  }
  return url;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RoundtableError(`${name}必须为正数`, 'INVALID_INPUT');
  return value;
}

function roomId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(value)) {
    throw new RoundtableError('讨论 ID 无效', 'INVALID_INPUT');
  }
  return value;
}

export function prepareInput(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new RoundtableError('输入必须为 JSON 对象', 'INVALID_INPUT');
  if (typeof input.topic !== 'string' || !input.topic.trim()) throw new RoundtableError('topic 必须包含完整讨论主题', 'INVALID_INPUT');
  const data = { topic: input.topic.trim(), mode: input.mode ?? 'decide' };
  if (!['decide', 'brainstorm', 'review', 'paper', 'learn'].includes(data.mode)) throw new RoundtableError('讨论模式无效', 'INVALID_INPUT');
  for (const key of ['cwd', 'background']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') throw new RoundtableError(`${key} 必须为文本`, 'INVALID_INPUT');
      data[key] = input[key];
    }
  }
  for (const [key, min, max, fallback] of [['maxRounds', 1, 10, data.mode === 'review' ? 1 : 3], ['maxTurns', 0, 200, 20]]) {
    data[key] = input[key] ?? fallback;
    if (!Number.isInteger(data[key]) || data[key] < min || data[key] > max) throw new RoundtableError(`${key} 必须为 ${min}–${max} 的整数`, 'INVALID_INPUT');
  }
  if (input.models !== undefined) {
    if (!input.models || typeof input.models !== 'object' || Array.isArray(input.models)) throw new RoundtableError('models 必须为对象', 'INVALID_INPUT');
    data.models = input.models;
  }
  return data;
}

export class RoundtableClient {
  constructor({ url, requestTimeoutMs = 10000 } = {}) {
    this.base = localUrl(url);
    this.requestTimeoutMs = positive(requestTimeoutMs, '请求超时');
  }

  roomUrl(id) { return `${this.base.origin}/?room=${encodeURIComponent(roomId(id))}`; }

  request(method, path, data, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    positive(timeoutMs, '请求超时');
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.startsWith('//')) throw new RoundtableError('请求路径必须为本机 API', 'INVALID_INPUT');
    const body = data === undefined ? undefined : JSON.stringify(data);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const req = http.request(new URL(path, this.base), {
        method, signal,
        // localhost 也固定拨本机，避免 DNS 配置把材料送到其他机器。
        lookup: (_host, options, callback) => options.all
          ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          finish(new RoundtableError('讨论室返回重定向，已拒绝跟随', 'REDIRECT_REFUSED'));
          res.destroy();
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            finish(new RoundtableError('讨论室响应超过 8 MiB，请打开网页查看', 'RESPONSE_TOO_LARGE'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('end', () => {
          if (settled) return;
          let result;
          try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(new RoundtableError('讨论室未返回 JSON；请检查地址及服务版本', 'INVALID_RESPONSE')); return; }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finish(new RoundtableError(result?.error || `HTTP ${res.statusCode}`, `HTTP_${res.statusCode}`));
          } else finish(null, result);
        });
      });
      timer = setTimeout(() => req.destroy(new RoundtableError('请求超时；讨论可能仍在服务端继续', 'REQUEST_TIMEOUT')), timeoutMs);
      req.on('error', (error) => finish(error));
      req.end(body);
    });
  }

  async start(input, options) {
    const created = await this.request('POST', '/api/rooms', prepareInput(input), options);
    const id = roomId(created?.id);
    return { id, url: this.roomUrl(id), ready: false, state: 'started', nextAction: '使用 wait 或 result 取回结论，也可打开链接插话。' };
  }

  async result(id, options) {
    roomId(id);
    const result = await this.request('GET', `/api/rooms/${id}/result`, undefined, options);
    if (!result || typeof result.ready !== 'boolean' || typeof result.status !== 'string' || typeof result.phase !== 'string') {
      throw new RoundtableError('结果接口格式不兼容，请重启最新版本讨论室', 'INVALID_RESPONSE');
    }
    let state = 'pending';
    let nextAction = '继续使用 wait 或 result 取回结论。';
    if (result.ready) { state = 'complete'; nextAction = result.newSince ? `结论已返回，但之后又讨论了 ${result.newSince} 次、尚未纳入；需要时在网页点「更新结论」。` : '结论已返回；结合复核内容使用。'; }
    else if (['paused', 'stopped', 'failed', 'error'].includes(result.status)) {
      state = 'needs_attention'; nextAction = '打开讨论链接查看暂停或失败原因，调整后继续，或手动总结。';
    } else if (result.status === 'waiting') {
      state = 'needs_attention'; nextAction = result.phase === 'done'
        ? '讨论已结束但没有可交付定稿；打开链接检查总结与复核。'
        : '讨论正在等你回答；打开链接补充信息后继续。';
    }
    return { ...result, id, url: this.roomUrl(id), state, nextAction };
  }

  async wait(id, { timeoutMs = 60000, signal, initialDelayMs = 1000, maxDelayMs = 5000 } = {}) {
    positive(timeoutMs, '等待超时');
    positive(initialDelayMs, '轮询间隔');
    positive(maxDelayMs, '最大轮询间隔');
    const deadline = Date.now() + timeoutMs;
    let interval = Math.min(initialDelayMs, maxDelayMs);
    let result;
    while (Date.now() < deadline) {
      try {
        result = await this.result(id, { signal, timeoutMs: Math.min(this.requestTimeoutMs, Math.max(1, deadline - Date.now())) });
      } catch (error) {
        if (error.code === 'REQUEST_TIMEOUT' && Date.now() >= deadline) break;
        throw error;
      }
      if (result.state !== 'pending') return result;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(interval, remaining), undefined, { signal });
      interval = Math.min(maxDelayMs, interval * 1.5);
    }
    return { ...result, id, url: this.roomUrl(id), ready: false, state: 'timeout', nextAction: '本次等待已结束，讨论未被取消；稍后用同一 ID 运行 result 或 wait。' };
  }
}
