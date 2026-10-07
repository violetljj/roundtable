import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSourceReference, previewSource } from '../lib/source-reference.js';

test('解析来源中的相对、绝对、Markdown 和带空格引用', () => {
  assert.deepEqual(parseSourceReference('本场读取｜lib/room.js:56'), { file: 'lib/room.js', line: 56 });
  assert.deepEqual(parseSourceReference('旧对话 `E:\\roundtable\\lib\\room.js:12`'), { file: 'E:\\roundtable\\lib\\room.js', line: 12 });
  assert.deepEqual(parseSourceReference('[文件](lib/room.js:12)'), { file: 'lib/room.js', line: 12 });
  assert.deepEqual(parseSourceReference('`docs/My Notes.md:3`'), { file: 'docs/My Notes.md', line: 3 });
  assert.deepEqual(parseSourceReference('[文件](<E:/roundtable/docs/My Notes.md:3>)'), { file: 'E:/roundtable/docs/My Notes.md', line: 3 });
  assert.deepEqual(parseSourceReference('本场读取 lib/room.js:56、lib/codex.js:20'), { file: 'lib/room.js', line: 56 });
  assert.throws(() => parseSourceReference('来自记忆，未核实'));
});

test('来源预览携带当前哈希并拒绝越界、私密文件和失效行号', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roundtable-source-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  fs.writeFileSync(path.join(dir, 'sample.js'), '一\n二\n三');
  fs.writeFileSync(path.join(dir, '.env'), 'secret');
  const result = previewSource(dir, 'sample.js:2');
  assert.equal(result.line, 2);
  assert.deepEqual(result.lines, ['一', '二', '三']);
  assert.equal(result.sha256.length, 64);
  assert.match(result.notice, /当前文件/);
  assert.throws(() => previewSource(dir, '../outside.txt:1'), /项目内/);
  assert.throws(() => previewSource(dir, '.env:1'), /私密/);
  assert.throws(() => previewSource(dir, 'sample.js:99'), /过时/);
  fs.writeFileSync(path.join(dir, 'binary.dat'), Buffer.from([0, 1]));
  assert.throws(() => previewSource(dir, 'binary.dat:1'), /二进制/);
  fs.mkdirSync(path.join(dir, 'target'));
  fs.writeFileSync(path.join(dir, 'target', 'file.txt'), 'test');
  fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'linked'), 'junction');
  assert.throws(() => previewSource(dir, 'linked/file.txt:1'), /链接/);
});
