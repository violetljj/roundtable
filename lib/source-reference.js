// 引用预览只读项目内当前文本，不把路径存在当作观点已核实。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function parseSourceReference(value) {
  const text = String(value ?? '').trim();
  // 支持反引号、Markdown 链接、Windows 绝对路径和普通相对路径。
  const linked = text.match(/\]\(<?([^<>]+?:\d+(?::\d+)?)>?\)/)?.[1];
  const quoted = text.match(/`([^`]+:\d+(?::\d+)?)`/)?.[1];
  const match = linked || quoted
    ? (linked ?? quoted).match(/^(.+?):(\d+)(?::\d+)?$/)
    : text.match(/((?:[A-Za-z]:[\\/])?[^:\s`<>|｜，；：、,;()]+?):(\d+)(?::\d+)?(?:$|[\s，；。、,;)])/);
  if (!match) throw new Error('这条来源没有可预览的文件:行号；可以回到原发言核查。');
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) throw new Error('引用行号无效');
  return { file: match[1], line };
}

export function previewSource(root, reference) {
  const { file, line } = parseSourceReference(reference);
  if (file.includes('\0') || /^[a-z]+:\/\//i.test(file)) throw new Error('只支持项目文件引用');
  const base = fs.realpathSync(root);
  const absolute = path.resolve(base, file.replace(/[\\/]/g, path.sep));
  const relative = path.relative(base, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('只能预览当前项目内的文件');
  const segments = relative.split(path.sep);
  if (segments.some((s) => /^(?:\.git|\.env(?:\..*)?|\.claude|\.codex|credentials?(?:\..*)?|secrets?(?:\..*)?|rooms)$/i.test(s)) || /\.(?:pem|key|pfx|p12)$/i.test(file)) throw new Error('此类本机配置或私密文件不提供网页预览');
  let cursor = base;
  for (const segment of segments) {
    if (segment.includes(':')) throw new Error('文件路径无效');
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('不预览链接指向的文件');
  }
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('只预览不超过 1 MiB 的文本文件');
  const bytes = fs.readFileSync(absolute);
  if (bytes.includes(0)) throw new Error('无法预览二进制文件');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('只预览 UTF-8 文本文件'); }
  const lines = text.split(/\r?\n/);
  if (line > lines.length) throw new Error(`当前文件只有 ${lines.length} 行，原引用可能已过时`);
  const start = Math.max(1, line - 5);
  return {
    file: relative.replaceAll(path.sep, '/'), line, start,
    lines: lines.slice(start - 1, Math.min(lines.length, line + 8)).map((s) => s.slice(0, 2000)),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    modifiedAt: stat.mtimeMs, readAt: Date.now(),
    notice: '这是当前文件的只读预览，可能已与发言时不同；不代表来源已被模型读取或主张已获验证。',
  };
}
