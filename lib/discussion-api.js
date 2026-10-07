import { conclusionFromRoom } from './discussion-quality.js';

// HTTP 接入保持薄层；实验报告以独立证据进入讨论，不提升为用户指令。
export function roomResult(room) {
  const result = conclusionFromRoom(room.d);
  const busy = !!room.speaking?.size;
  return {
    ...result, ready: result.ready && !busy,
    id: room.d.id, status: room.d.status, phase: room.d.phase,
    notice: room.d.notice ?? '',
  };
}

export async function experimentAction(room, action, body = {}) {
  if (!room.experiment) throw new Error('小实验功能未初始化');
  const experiment = room.experiment;
  if (action === 'card') {
    if (!['discussion', 'done'].includes(room.d.phase) || room.d.status === 'stopped') {
      throw new Error('双方完成独立提案后才能申请小实验；总结期间请先等待定稿。');
    }
    const state = await experiment.saveCard(body);
    room.pause();
    // done 的 waiting 状态没有正在运行的讨论，也可进入明确的暂停状态。
    if (room.d.status === 'waiting' && !room.speaking.size) {
      room.d.status = 'paused';
      room.d.notice = '实验卡已保存，等待你确认运行。';
      room.emit('event', { type: 'state', state: room.snapshot() });
      room.save(true);
    }
    return state;
  }
  if (action === 'start') return experiment.start(body);
  if (action === 'cancel') return experiment.cancel();
  if (action === 'return') {
    if (!['discussion', 'done'].includes(room.d.phase) || room.speaking.size || room.d.status === 'stopped') {
      throw new Error('请等发言或总结完成，再把实验带回讨论。');
    }
    await experiment.returnResult(body, (evidence, id) => room.acceptExperiment(evidence, id));
    return experiment.snapshot();
  }
  throw new Error('未知的小实验操作');
}

export function assertDiscussionAvailable(room, action) {
  if (room.experiment?.snapshot()?.status === 'running'
      && ['message', 'resume', 'finish', 'finalize', 'check', 'reopen', 'resummarize'].includes(action)) {
    throw new Error('小实验正在运行；请等待完成或先取消实验，再继续讨论。');
  }
}
