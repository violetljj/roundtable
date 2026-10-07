const MODEL = new Set(['claude', 'codex']);

// 只用明确的请求批次关联，不能按相邻发言猜测谁答了核查。
export function indexMessageLinks(messages, experiment) {
  const list = [...messages];
  const requests = new Map(list.filter((m) => m.from === 'user' && m.relatedMessageId).map((m) => [m.id, m]));
  const experimentResponses = new Map();
  const links = new Map();
  const entry = (id) => {
    if (!links.has(id)) links.set(id, { checks: [], experiments: [], assessments: [] });
    return links.get(id);
  };
  for (const request of requests.values()) {
    const responses = list.filter((m) => MODEL.has(m.from) && m.status === 'complete' && m.responseToMessageIds?.includes(request.id)
      && (!request.target || request.target === 'all' || request.target === m.from));
    if (request.experimentId) {
      entry(request.relatedMessageId).assessments.push(...responses);
      experimentResponses.set(request.experimentId, responses);
    }
    else entry(request.relatedMessageId).checks.push({ request, responses });
  }
  const records = experiment ? [...(experiment.history ?? []), experiment] : [];
  for (const record of records) {
    if (record.sourceMessageId) entry(record.sourceMessageId).experiments.push({ ...record, responses: experimentResponses.get(record.id) ?? [] });
  }
  return links;
}

// 只带入明确命名的字段，其余留空给用户裁定，不额外调用模型。
export function experimentSeed(text, selected = '') {
  const labels = {
    question: '分歧问题|要裁决的分歧|实验问题',
    decisionRule: '判据|判定标准|什么结果会改变结论',
    procedure: '实验步骤|实验步骤与范围|实验方法',
  };
  const card = {};
  for (const [field, names] of Object.entries(labels)) {
    const match = text.match(new RegExp(`(?:^|\\n)[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?(?:【(?:${names})】(?:\\*\\*)?[ \\t]*[:：]?|(?:${names})(?:\\*\\*)?[ \\t]*[:：](?:\\*\\*)?)[ \\t]*([^\\n]+)`, 'u'));
    card[field] = match?.[1]?.replace(/^\*\*\s*|\s*\*\*$/g, '').trim() ?? '';
  }
  if (selected) card.question = selected.slice(0, 12000);
  return { card, suggested: !!card.procedure && !!card.decisionRule && /实验/.test(text) };
}
