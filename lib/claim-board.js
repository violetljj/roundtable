// 从完成的原始发言派生卡片；出处和双方同意都不自动升级为已验证。
export const CLAIM_PROTOCOL = '【可核查判断】有关键可核查判断时，逐条单独写「【主张】具体判断」「【来源】本场读取 / 旧对话未复核 / 推断，并附文件:行号或其他位置」「【验证】怎样验证或推翻」。每个标记独占一行；推测和建议请标明，不要为凑卡片重复观点。';

const discussions = new Set(['unresolved', 'consensus', 'disputed']);
const evidenceStates = new Set(['unverified', 'supported', 'counter']);

export function isCompleteModelMessage(message) {
  return message?.status === 'complete' && ['claude', 'codex'].includes(message.from);
}

export function claimsFromMessages(messages, annotations = {}) {
  const claims = [];
  for (const message of messages) {
    if (!isCompleteModelMessage(message)) continue;
    let fence = null;
    let current = null;
    let ordinal = 0;
    for (const line of String(message.forward ?? message.text ?? '').split(/\r?\n/)) {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }
      if (marker) { fence = { char: marker[1][0], length: marker[1].length }; continue; }
      const match = line.match(/^ {0,3}【(主张|来源|验证)】\s*(.*)$/);
      if (!match) continue;
      const value = match[2].trim();
      if (match[1] === '主张') {
        current = null;
        ordinal++;
        if (!value) continue;
        const id = `${message.id}:${ordinal}`;
        const annotation = Object.hasOwn(annotations, id) ? annotations[id] : {};
        current = {
          id, messageId: message.id, from: message.from, text: value, sources: [], verification: '',
          discussion: discussions.has(annotation?.discussion) ? annotation.discussion : 'unresolved',
          evidence: evidenceStates.has(annotation?.evidence) ? annotation.evidence : 'unverified',
          note: typeof annotation?.note === 'string' ? annotation.note : '',
        };
        claims.push(current);
      } else if (current && value) {
        if (match[1] === '来源') current.sources.push(value);
        else current.verification = [current.verification, value].filter(Boolean).join('\n');
      }
    }
  }
  return claims;
}

export function claimAnnotation(input, previous = {}) {
  const next = { ...previous };
  if (Object.hasOwn(input, 'discussion')) {
    if (!discussions.has(input.discussion)) throw new Error('无效的讨论状态');
    next.discussion = input.discussion;
  }
  if (Object.hasOwn(input, 'evidence')) {
    if (!evidenceStates.has(input.evidence)) throw new Error('无效的证据状态');
    next.evidence = input.evidence;
  }
  if (Object.hasOwn(input, 'note')) {
    if (typeof input.note !== 'string' || input.note.length > 4000) throw new Error('标注备注必须是最多 4000 字的文本');
    next.note = input.note.trim();
  }
  return { discussion: next.discussion ?? 'unresolved', evidence: next.evidence ?? 'unverified', note: next.note ?? '' };
}
