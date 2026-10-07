import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoundtableClient, localUrl, prepareInput } from '../lib/roundtable-client.js';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function json(res, value, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
const pending = { ready: false, status: 'running', phase: 'discussion' };
const done = { ready: true, status: 'waiting', phase: 'done', text: '三句话与完整结论', brief: '建议保留缓存。', full: '完整结论。', review: '无异议', messageId: 'm1' };

test('从完整问题包创建，快速审查默认一轮，结果包含已复核正文与链接', async (t) => {
  const calls = [];
  const url = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body && JSON.parse(body) });
    json(res, req.method === 'POST' ? { id: 'room-1' } : done);
  });
  const client = new RoundtableClient({ url });
  const created = await client.start({ topic: '方案审查', cwd: 'E:\\project', background: '零新增依赖', mode: 'review', forkFrom: { codex: '不应隐式复制' } });
  assert.equal(created.id, 'room-1');
  assert.equal(calls[0].body.maxRounds, 1);
  assert.equal(calls[0].body.background, '零新增依赖');
  assert.equal(calls[0].body.forkFrom, undefined);
  const result = await client.result(created.id);
  assert.equal(result.state, 'complete');
  assert.equal(result.full, done.full);
  assert.equal(result.url, `${url}/?room=room-1`);
});

test('waiting 非 done、暂停、停止与失败均及时交回操作者', async (t) => {
  let body;
  const url = await fixture(t, (_req, res) => json(res, body));
  const client = new RoundtableClient({ url });
  for (const status of ['waiting', 'paused', 'stopped', 'failed']) {
    body = { ...pending, status };
    const result = await client.wait('r1', { timeoutMs: 1000 });
    assert.equal(result.state, 'needs_attention');
    assert.equal(result.ready, false);
  }
  body = { ...pending, status: 'waiting', phase: 'done' };
  assert.equal((await client.wait('r1')).state, 'needs_attention');
});

test('有限轮询取得结果，等待到时不会发停止请求', async (t) => {
  let requests = 0;
  let finish = true;
  const methods = [];
  const url = await fixture(t, (req, res) => {
    methods.push(`${req.method} ${req.url}`);
    json(res, finish && ++requests >= 3 ? done : pending);
  });
  const client = new RoundtableClient({ url });
  assert.equal((await client.wait('r1', { timeoutMs: 1000, initialDelayMs: 5, maxDelayMs: 10 })).state, 'complete');
  finish = false;
  const result = await client.wait('r1', { timeoutMs: 35, initialDelayMs: 5, maxDelayMs: 10 });
  assert.equal(result.state, 'timeout');
  assert.equal(result.id, 'r1');
  assert.ok(methods.every((item) => item === 'GET /api/rooms/r1/result'));
});

test('绝对请求超时也约束没有响应的服务，等待不会超出自身期限', async (t) => {
  const url = await fixture(t, () => {});
  const client = new RoundtableClient({ url, requestTimeoutMs: 30 });
  await assert.rejects(client.result('r1'), { code: 'REQUEST_TIMEOUT' });
  const start = Date.now();
  const result = await client.wait('r1', { timeoutMs: 20 });
  assert.equal(result.state, 'timeout');
  assert.ok(Date.now() - start < 500);
});

test('远程地址、凭证、重定向和错误结果被拒绝', async (t) => {
  for (const url of ['https://127.0.0.1:4545', 'http://example.com', 'http://127.0.0.1.example.com', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost/?token=x']) {
    assert.throws(() => localUrl(url), { code: 'INVALID_URL' });
  }
  let response = 'redirect';
  let count = 0;
  const url = await fixture(t, (_req, res) => {
    count++;
    if (response === 'redirect') { res.writeHead(302, { location: 'http://example.com/private' }); res.end(); }
    else if (response === 'error') json(res, { error: '讨论不存在' }, 404);
    else json(res, {});
  });
  const client = new RoundtableClient({ url });
  await assert.rejects(client.result('r1'), { code: 'REDIRECT_REFUSED' });
  assert.equal(count, 1);
  response = 'error';
  await assert.rejects(client.result('r1'), { code: 'HTTP_404', message: '讨论不存在' });
  response = 'invalid';
  await assert.rejects(client.result('r1'), { code: 'INVALID_RESPONSE' });
});

test('取消客户端等待只断开请求，且 localhost 固定访问本机', async (t) => {
  let seen;
  const url = await fixture(t, (req) => { seen = req.method; });
  const client = new RoundtableClient({ url: url.replace('127.0.0.1', 'localhost') });
  const controller = new AbortController();
  const waiting = client.wait('r1', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 40);
  try { await assert.rejects(waiting, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  assert.equal(seen, 'GET');
});

test('CLI 读取带 BOM 的 UTF-8 JSON 并把结果交回，非法参数不创建讨论', async (t) => {
  let creates = 0;
  const url = await fixture(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'POST') { creates++; assert.equal(JSON.parse(body).topic, '中文主题'); }
    json(res, req.method === 'POST' ? { id: 'r1' } : done);
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roundtable-client-'));
  const input = path.join(dir, 'input.json');
  t.after(async () => { await fs.unlink(input); await fs.rmdir(dir); });
  await fs.writeFile(input, '\uFEFF' + JSON.stringify({ topic: '中文主题', mode: 'review' }));
  const cli = fileURLToPath(new URL('../scripts/roundtable.js', import.meta.url));
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const success = await run('start', '--input', input, '--url', url, '--wait');
  assert.equal(success.code, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).state, 'complete');
  assert.equal(JSON.parse(success.stderr).id, 'r1');
  const invalid = await run('start', '--input', input, '--url', url, '--timeout', 'Infinity');
  assert.equal(invalid.code, 1);
  assert.equal(creates, 1);
});

test('输入边界在发起讨论前校验，保留自选模型', () => {
  for (const input of [{}, { topic: 3 }, { topic: '题目', maxRounds: 100 }, { topic: '题目', maxTurns: -1 }, { topic: '题目', mode: 'other' }]) {
    assert.throws(() => prepareInput(input), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(prepareInput({ topic: '题目', models: { claude: { model: 'haiku', effort: 'low' } } }).models, { claude: { model: 'haiku', effort: 'low' } });
});
