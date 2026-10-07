import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLedger, createNotificationTracker, initNotifications } from '../public/notifications.js';

const running = { topic: '测试讨论', status: 'running', phase: 'discussion', round: 1, turnInRound: 0 };
function setup() {
  const events = [];
  const ledger = createEventLedger();
  const tracker = createNotificationTracker({ emit: (event) => events.push(event), claim: ledger });
  tracker.observe('r', null, running);
  return { tracker, events };
}

test('首次及重连快照不通知历史，正常等待转换仅一次', () => {
  const { tracker, events } = setup();
  const waiting = { ...running, status: 'waiting' };
  tracker.observe('r', running, waiting);
  tracker.observe('r', waiting, waiting);
  tracker.observe('r', null, waiting);
  tracker.observe('r', waiting, waiting);
  tracker.observe('old', null, { ...waiting, phase: 'done' });
  assert.deepEqual(events.map((x) => x.kind), ['waiting']);
});

test('完成仅通知一次，自由问答不重复；暂停和停止静默', () => {
  const { tracker, events } = setup();
  const done = { ...running, phase: 'done', status: 'waiting' };
  tracker.observe('r', running, done);
  tracker.observe('r', done, { ...done, status: 'running' });
  tracker.observeMessage('r', { id: 'free', status: 'complete', from: 'codex' });
  tracker.observe('r', running, done);
  tracker.observe('r', done, { ...done, status: 'paused', notice: '已暂停。' });
  tracker.observe('r', done, { ...done, status: 'stopped' });
  assert.deepEqual(events.map((x) => x.kind), ['done']);
});

test('上限暂停仅通知一次，新的用户问题可以再次通知', () => {
  const { tracker, events } = setup();
  const cap = { ...running, status: 'paused', capHit: true, notice: '已达到本场发言上限（20 次）' };
  tracker.observe('r', running, cap);
  tracker.observe('r', cap, cap);
  tracker.observe('r', cap, running);
  tracker.observe('r', running, { ...running, status: 'paused', capHit: true, notice: '已暂停。' });
  tracker.observe('r', cap, running);
  tracker.observeMessage('r', { id: 'q1', status: 'complete' });
  tracker.observe('r', running, { ...running, status: 'waiting' });
  tracker.observe('r', running, running);
  tracker.observeMessage('r', { id: 'q2', status: 'complete' });
  tracker.observe('r', running, { ...running, status: 'waiting' });
  assert.deepEqual(events.map((x) => x.kind), ['cap', 'waiting', 'waiting']);
});

test('失败消息和随后的出错状态合为一次，重试失败另行通知', () => {
  const { tracker, events } = setup();
  const failed = { ...running, status: 'paused', notice: 'Codex 出错：请求失败' };
  tracker.observeMessage('r', { id: 'a', from: 'codex', status: 'streaming' });
  tracker.observeMessage('r', { id: 'a', from: 'codex', status: 'failed' });
  tracker.observeMessage('r', { id: 'a', from: 'codex', status: 'failed' });
  tracker.observe('r', running, failed);
  tracker.observe('r', failed, running);
  tracker.observeMessage('r', { id: 'b', from: 'codex', status: 'streaming' });
  tracker.observeMessage('r', { id: 'b', from: 'codex', status: 'failed' });
  tracker.observe('r', running, failed);
  assert.equal(events.length, 2);
  assert.ok(events.every((x) => x.kind === 'failed'));
});

test('初始化等没有失败消息的错误也通知，历史失败快照不通知', () => {
  const { tracker, events } = setup();
  const failed = { ...running, status: 'paused', notice: '出错已暂停：连接不可用' };
  tracker.observe('r', running, failed);
  tracker.observe('r', null, failed);
  tracker.observe('r', failed, failed);
  assert.equal(events.length, 1);
  tracker.observe('r', failed, running);
  tracker.observe('r', running, { ...failed, notice: '出错已暂停：另一条错误' });
  assert.equal(events.length, 2);
});

test('共享存储去重有界且存储损坏不影响使用', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  const a = createEventLedger(storage, () => 100);
  const b = createEventLedger(storage, () => 100);
  assert.equal(a('same'), true);
  assert.equal(b('same'), false);
  for (let i = 0; i < 600; i++) a(String(i));
  assert.equal(JSON.parse([...values.values()][0]).length, 512);
  const unavailable = createEventLedger({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(unavailable('same'), true);
  assert.equal(unavailable('same'), false);
  const malformed = createEventLedger({ getItem: () => '{broken', setItem() {} });
  assert.equal(malformed('fresh'), true);
});

test('Node 导入与初始化不依赖浏览器', () => {
  const ui = initNotifications({});
  ui.observe('r', null, running);
  ui.observeMessage('r', { status: 'failed' });
  ui.dispose();
});

function browserFixture(permission = 'default') {
  const elements = [];
  function element() {
    const el = { style: {}, children: [], attributes: {}, append(...items) { this.children.push(...items); },
      setAttribute(key, value) { this.attributes[key] = value; }, remove() { this.removed = true; } };
    elements.push(el);
    return el;
  }
  const sidebar = { insertBefore() {} };
  const document = { createElement: element, getElementById: (id) => id === 'sidebar' ? sidebar : null };
  const values = new Map();
  const notices = [];
  let requests = 0;
  class Notification {
    static permission = permission;
    static async requestPermission() { requests++; this.permission = 'granted'; return 'granted'; }
    constructor(title, options) { this.title = title; this.options = options; notices.push(this); }
    close() { this.closed = true; this.onclose?.(); }
  }
  const listeners = new Map();
  const window = { Notification, localStorage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: (name) => listeners.delete(name),
    focus() { this.focused = true; } };
  return { window, document, elements, notices, listeners, requests: () => requests };
}

test('权限仅点击时请求，记住启用、通知点击回房间并清理', async () => {
  const env = browserFixture();
  const opened = [];
  const ui = initNotifications({ ...env, openRoom: (id) => opened.push(id) });
  assert.equal(env.requests(), 0);
  const button = env.elements[1];
  await button.onclick();
  assert.equal(env.requests(), 1);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(env.window.localStorage.getItem('roundtable:notifications:enabled'), 'true');
  ui.observe('r', null, running);
  ui.observe('r', running, { ...running, status: 'waiting' });
  assert.equal(env.notices.length, 1);
  env.notices[0].onclick();
  assert.deepEqual(opened, ['r']);
  assert.equal(env.window.focused, true);
  assert.equal(env.notices[0].closed, true);
  await button.onclick();
  ui.observe('r', running, running);
  ui.observeMessage('r', { id: 'next', status: 'complete' });
  ui.observe('r', running, { ...running, status: 'waiting' });
  assert.equal(env.notices.length, 1);
  ui.dispose();
  assert.equal(env.listeners.size, 0);
  assert.equal(env.elements[0].removed, true);
});

test('拒绝权限和不支持浏览器有明确文案且不请求权限', () => {
  for (const supported of [true, false]) {
    const env = browserFixture('denied');
    if (!supported) delete env.window.Notification;
    const ui = initNotifications(env);
    assert.equal(env.elements[1].disabled, true);
    assert.match(env.elements[2].textContent, supported ? /网站权限/ : /不支持/);
    assert.equal(env.requests(), 0);
    ui.dispose();
  }
});
