// 提示与结果提取不依赖连接器，供讨论室和外部入口共用。
export const QUALITY_RULES = [
  '关键反驳要引用对方具体原话或明确定位观点，并用一句话说明你的理解、真正分歧和依据；如果对方纠正了你的理解，先校正再继续，不把推测写成对方的主张。',
  '不必机械复述每条消息，也不必为了唱反调制造分歧。检查当前建议最脆弱的假设，以及它不成立会怎样；检查后可以认同。',
  '每轮说明尚未解决、可能改变判断的问题。事实分歧转为明确的查证或小实验建议（写清判别结果、资源与时限），偏好取舍交给用户；没有新依据时保留分歧，不重复已有理由。',
  '探索想法模式继续寻找不同机制、组合和成立条件，保留有潜力但未验证的方向；上述规则不要求提前收敛，也不改变用户设定的轮数和预算。',
].join('\n');

export const SUMMARY_RULES = [
  '总结必须同时给出两个版本，按以下固定二级标题排列：',
  '## 三句话版',
  '恰好三句话：第一句说建议什么；第二句说依据是什么及证据边界；第三句说什么条件或新证据会改变建议。保留会影响决定的分歧，不把未验证的设想说成事实。',
  '## 完整版',
  '在此标题下按本模式的总结项目展开；各项目使用三级标题，保留双方立场、证据、限制与下一步。两版结论必须一致，短版不能省略改变建议的关键条件。',
].join('\n');

export const REVIEW_RULES = [
  '同时复核“三句话版”和“完整版”：是否准确表达双方原意，依据是否成立，是否遗漏重要分歧或改变建议的条件，两版是否一致。',
  '首行只写「【复核】无异议」或「【复核】有更正」，随后给出具体出处和修改内容；任一版本有实质问题都应标记有更正。',
  '合并成定稿时保留「## 三句话版」和「## 完整版」；将复核更正同步到两个版本，只改受更正影响的内容。不得把复核的纠正留在短版之外。',
].join('\n');

export const EXTRA_MODES = {
  paper: {
    name: '论文审稿',
    converge: true,
    goal: '本场目标是投稿前的论文审稿模拟。双方先独立审稿，避免过早替论文辩护，再核对批评并整理作者回应清单。区分论文原文、已有实验、推断和待补证据，不把模拟审稿当作真实审稿或录用预测。',
    independent: '请独立审稿：先概括论文实际主张，再按严重程度给出具体问题，引用章节或原文并说明会影响哪条结论；列出站得住的贡献、尚缺材料和可判定问题的验证。尚未读到论文时只指出缺失材料，不编造内容。此阶段双方都是审稿人，不先扮作者辩护。',
    discuss: '先回应用户，再核对双方审稿意见的原文依据和分歧；对确认的问题逐条形成作者回应草案，区分澄清、修改、补实验与有据反驳。缺证据的回应保留待办，不能写成已完成；不要替作者承诺不存在的结果。',
    summary: ['### 审稿意见（严重程度、原文依据与影响）', '### 有争议的批评与各自理由', '### 作者回应清单（回应草案、修改位置、待补证据）', '### 投稿前优先行动与仍未验证的结论'],
  },
  learn: {
    name: '双人讲课',
    converge: true,
    goal: '本场目标是帮助用户理解主题。双方先独立规划讲解路线；交叉阶段由本场先发言方负责讲解，另一方负责追问缺失的推导、反例和适用条件。角色固定，用户可以随时插话改变深度。',
    independent: '请独立规划一条适合用户现有背景的学习路线：核心概念、一个具体例子、最容易误解的一点和一个理解检验题。背景不明确时简述采用的起点，只问会改变讲解路线的关键问题。不要声称用户已经理解。',
    discuss: '沿本场指定角色推进：先发言方用具体例子逐步讲解，另一方挑出缺失步骤、边界条件或反例并追问；双方都优先回答用户插话。不要只互相展示知识；根据用户实际回答调整，而不是把沉默当作掌握。',
    summary: ['### 核心概念与推导', '### 具体例子、反例与适用边界', '### 用户问题及回答', '### 理解检验（一道可迁移的小题，参考答案与判断要点）', '### 尚未确认的理解与下一步学习'],
  },
};

const isModel = (message) => message && ['claude', 'codex'].includes(message.from);
const bodyOf = (message) => String(message?.forward ?? message?.text ?? '').trim();

// 只接受明确的确认；空白或含混的旧复核不能自动升级成已审查结论。
export function reviewVerdict(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  const first = lines.find((line) => line.trim())?.trim() ?? '';
  const marker = first.match(/^【复核】\s*(无异议|有更正)(?:\s|[，。:：；;！!]|$)/);
  if (marker) return marker[1] === '无异议' ? 'accepted' : 'corrections';
  if (/^(无异议|没有异议)(?:\s|[，。:：；;！!]|$)/.test(first) && !/更正|歪曲|不准确|遗漏|需要修正/.test(text)) return 'accepted';
  return /更正|歪曲|不准确|遗漏|需要修正|不主张|没有建议/.test(text) ? 'corrections' : 'unknown';
}

export function splitConclusion(text) {
  const normalized = String(text ?? '').trim();
  const lines = normalized.split(/\r?\n/);
  let fence = null;
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && /^##\s+(三句话版|完整版)\s*$/.test(line)) headings.push({ index, title: line.trim().slice(3).trim() });
  }
  const briefHeading = headings.find((heading) => heading.title === '三句话版');
  const fullHeading = headings.find((heading) => heading.title === '完整版' && heading.index > (briefHeading?.index ?? -1));
  if (!briefHeading || !fullHeading) return { brief: '', full: normalized };
  return {
    brief: lines.slice(briefHeading.index + 1, fullHeading.index).join('\n').trim(),
    full: lines.slice(fullHeading.index + 1).join('\n').trim(),
  };
}

export function conclusionFromRoom(data) {
  const empty = { ready: false, text: '', brief: '', full: '', messageId: null, review: '' };
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const latest = (kind, after = -1) => {
    for (let index = messages.length - 1; index > after; index--) {
      if (isModel(messages[index]) && messages[index].kind === kind) return { message: messages[index], index };
    }
    return null;
  };
  // 用最新尝试而非最新成功消息，防止重做失败后错误复用上一次结论。
  const summary = latest('summary');
  const review = summary && latest('review', summary.index);
  empty.review = review ? bodyOf(review.message) : '';
  if (data?.phase !== 'done' || !summary || summary.message.status !== 'complete' || !bodyOf(summary.message)
    || !review || review.message.status !== 'complete' || !empty.review) return empty;
  // 证据可能已落盘而恢复讨论尚未执行；旧定稿没有评估新实验。
  if (messages.slice(summary.index + 1).some((message) => message.from === 'evidence'
    && (message.kind === 'experiment' || message.experimentId))) return empty;
  // 再加一轮后停止也会进入 done；旧定稿尚未覆盖新讨论，不能当作本次结果。
  if (messages.slice(summary.index + 1).some((message) => isModel(message)
    && ['independent', 'discussion'].includes(message.phase))) return empty;

  const final = latest('final', review.index);
  let chosen;
  if (final) {
    if (final.message.status !== 'complete' || !bodyOf(final.message)) return empty;
    chosen = final.message;
  } else {
    if (reviewVerdict(empty.review) !== 'accepted') return empty;
    chosen = summary.message;
  }
  const text = bodyOf(chosen);
  return { ready: true, text, ...splitConclusion(text), messageId: chosen.id ?? null, review: empty.review };
}
