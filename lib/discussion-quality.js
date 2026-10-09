// 提示与结果提取不依赖连接器，供讨论室和外部入口共用。
// 讨论质量规则并入讨论室规则，只在开场说明和系统提示里出现一次；每轮重复会让模型把注意力花在守格式上。
export const QUALITY_RULES = [
  '反驳时先点明你回应的是对方哪句话、你怎么理解的，再说分歧和依据；对方纠正了你的理解，先校正再继续。',
  '不为反对而反对，也不为一致而附和：找出当前方案最脆弱的假设，检查后可以认同；有实质分歧就明确保留。',
  '事实分歧靠说理解决不了时，提出查证方法或小实验（写清怎样判定）；偏好取舍交给用户。没有新依据时不重复已有理由。',
];

export const SUMMARY_RULES = [
  '总结必须同时给出三个版本，按以下固定二级标题排列：',
  '## 三句话版',
  '恰好三句话：第一句说建议什么；第二句说依据是什么及证据边界；第三句说什么条件或新证据会改变建议。保留会影响决定的分歧，不把未验证的设想说成事实。',
  '## 完整版',
  '在此标题下按本模式的总结项目展开；各项目使用三级标题，保留双方立场、证据、限制与下一步。',
  '## 推进版',
  '写给接手推进的 Claude 或 Codex：对方没看过这场讨论，只读这一节就要能开始工作。用祈使句，具体到文件、命令、章节或判据，不写讨论经过和谁说了什么。依次用加粗小标题写：',
  '**目标**（一句话）；**已定决定**（已有共识、不必再争的选择）；**步骤**（编号，每步写动作和涉及的位置，需要先验证的放最前）；**约束**（不能做或必须保留的）；**验收**（怎样检查做完了：可运行的命令或可观察的结果）；**先问用户**（仍有分歧、属于用户取舍或证据不足的点，接手方遇到就停下来问，不自行决定；没有就写"无"）。',
  '推进版只整理讨论里已有的内容，不新增方案；讨论没落到具体文件时写"需先定位"，不编造路径。',
  '三个版本结论必须一致，短版不能省略改变建议的关键条件。',
].join('\n');

export const REVIEW_RULES = [
  '同时复核“三句话版”“完整版”和“推进版”：是否准确表达双方原意，依据是否成立，是否遗漏重要分歧或改变建议的条件，三版是否一致；推进版有没有把未定的分歧写成已定决定或步骤，有没有加进讨论里没有的方案或路径。',
  '首行只写「【复核】无异议」或「【复核】有更正」，随后给出具体出处和修改内容；任一版本有实质问题都应标记有更正。',
  '合并成定稿时保留「## 三句话版」「## 完整版」和「## 推进版」；将复核更正同步到各版本，只改受更正影响的内容。不得把复核的纠正留在短版或推进版之外。',
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
  const marker = first.match(/^【复核】\s*(无异议|有更正)[。.!！]?$/);
  if (marker) return marker[1] === '无异议' ? 'accepted' : 'corrections';

  // 旧记录只兼容明确措辞，引用和示例不能替复核者表态。
  let fence = null;
  const prose = [];
  for (const line of lines) {
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (boundary) {
      if (!fence) fence = boundary[1];
      else if (boundary[1][0] === fence[0] && boundary[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line) || /^\s*【复核】\s*(无异议|有更正)[。.!！]?\s*$/.test(line)) continue;
    prose.push(line.replace(/`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"/g, ''));
  }
  const clauses = prose.join('\n').split(/[，,。；;！!\n]/).map((part) => part.trim()).filter(Boolean);
  const confirmation = /^(?:无异议|没有异议|总结准确|没有遗漏|无遗漏|无需更正|无需修正|不需要更正|不需要修正)$/;
  const unresolved = clauses.filter((part) => !confirmation.test(part));
  const correction = /(?:需要|应当|应该)(?:更正|修正)|有(?:一处|两处|几处|一点|两点)?更正|(?:存在|发现)(?:遗漏|歪曲|不准确)|遗漏了|(?:总结|表述|结论)不准确|我(?:不主张|没有建议)/;
  const negative = /(?:无需|不需要|不必)(?:更正|修正)|(?:没有|不存在|无)(?:遗漏|更正|歪曲|不准确)/g;
  if (unresolved.some((part) => correction.test(part.replace(negative, '')))) return 'corrections';
  return clauses.length && !unresolved.length ? 'accepted' : 'unknown';
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
    if (!fence && /^##\s+(三句话版|完整版|推进版)\s*$/.test(line)) headings.push({ index, title: line.trim().slice(3).trim() });
  }
  const briefHeading = headings.find((heading) => heading.title === '三句话版');
  const fullHeading = headings.find((heading) => heading.title === '完整版' && heading.index > (briefHeading?.index ?? -1));
  if (!briefHeading || !fullHeading) return { brief: '', full: normalized, next: '' };
  // 推进版是后加的第三节，旧结论没有
  const nextHeading = headings.find((heading) => heading.title === '推进版' && heading.index > fullHeading.index);
  return {
    brief: lines.slice(briefHeading.index + 1, fullHeading.index).join('\n').trim(),
    full: lines.slice(fullHeading.index + 1, nextHeading?.index).join('\n').trim(),
    next: nextHeading ? lines.slice(nextHeading.index + 1).join('\n').trim() : '',
  };
}

export function conclusionFromRoom(data) {
  const empty = { ready: false, text: '', brief: '', full: '', next: '', messageId: null, review: '' };
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
  // 结论之后的自由问答不会自动并入结论：数出来交给界面提示"尚未纳入"，由用户决定是否更新
  const newSince = messages.slice((final ?? review).index + 1)
    .filter((message) => isModel(message) && message.status === 'complete' && message.phase === 'done').length;
  return { ready: true, text, ...splitConclusion(text), messageId: chosen.id ?? null, review: empty.review, newSince };
}
