// lib/util.mjs 的单元测试
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  newId,
  formatLocal,
  toIso,
  parseTimeToMs,
  asString,
  firstDefined,
  firstString,
  toStringArray,
  toIntOrNull,
  toFloatOrNull,
  toBoolOrNull,
  clampInt,
  truncate,
  safeJsonParse,
  escapeLike,
  escapeHtml,
  csvCell,
  safeDecodeURI,
  looksLikeHtml,
  looksLikeJson,
  looksLikeMarkdown,
  inferResultType,
  deriveTitle,
} from '../lib/util.mjs';

/* ----------------------------- ID / 时间 ----------------------------- */

test('newId 带前缀且不重复', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(newId('rec'));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^rec_[a-z0-9]+_[a-z0-9]{5}$/);
});

test('formatLocal 输出本地时间 YYYY-MM-DD HH:mm:ss', () => {
  const ms = new Date(2026, 8, 17, 9, 5, 3).getTime();
  assert.equal(formatLocal(ms), '2026-09-17 09:05:03');
  assert.equal(formatLocal(ms).length, 19);
  assert.match(toIso(ms), /^2026-09-17T/);
});

test('parseTimeToMs 支持各种时间写法', () => {
  assert.equal(parseTimeToMs('2026-09-17T03:48:12.006Z'), Date.parse('2026-09-17T03:48:12.006Z'));
  assert.equal(parseTimeToMs('2026-09-17 11:48:12'), new Date(2026, 8, 17, 11, 48, 12).getTime());
  assert.equal(parseTimeToMs('2026-09-17'), new Date(2026, 8, 17, 0, 0, 0).getTime());
  assert.equal(parseTimeToMs('2026-09-17T11:48:12+08:00'), Date.parse('2026-09-17T11:48:12+08:00'));
  assert.equal(parseTimeToMs(1758089292000), 1758089292000);
  assert.equal(parseTimeToMs('1758089292000'), 1758089292000);
  assert.equal(parseTimeToMs('1758089292'), 1758089292000);
  const date = new Date('2026-09-17T03:48:12.006Z');
  assert.equal(parseTimeToMs(date), date.getTime());
});

test('parseTimeToMs 解析失败时回退到 fallback', () => {
  assert.equal(parseTimeToMs('昨天下午', 12345), 12345);
  assert.equal(parseTimeToMs('', 999), 999);
  assert.equal(parseTimeToMs(null, 999), 999);
  assert.equal(parseTimeToMs(undefined, 999), 999);
  assert.ok(Number.isNaN(parseTimeToMs('乱写的', NaN)));
});

/* ----------------------------- 类型转换 ----------------------------- */

test('asString / firstDefined / firstString 的取值规则', () => {
  assert.equal(asString(0), '0');
  assert.equal(asString(false), 'false');
  assert.equal(asString(null), '');
  assert.deepEqual(safeJsonParse(asString({ a: 1 })), { a: 1 });
  assert.equal(firstDefined(undefined, null, '', 'x', 'y'), 'x');
  assert.equal(firstDefined(0, 5), 0);
  assert.equal(firstString(undefined, null, 'hi'), 'hi');
  assert.equal(firstString(undefined, null), '');
});

test('toStringArray 支持数组与中英文分隔符', () => {
  assert.deepEqual(toStringArray('a, b，c;d；e|f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(toStringArray(['x', 'x', ' y ']), ['x', 'y']);
  assert.deepEqual(toStringArray(''), []);
  assert.deepEqual(toStringArray(undefined), []);
});

test('数值与布尔转换', () => {
  assert.equal(toIntOrNull('42'), 42);
  assert.equal(toIntOrNull('4.6'), 5);
  assert.equal(toIntOrNull('abc'), null);
  assert.equal(toIntOrNull(''), null);
  assert.equal(toFloatOrNull('0.5'), 0.5);
  assert.equal(toFloatOrNull('x'), null);
  assert.equal(toBoolOrNull('yes'), true);
  assert.equal(toBoolOrNull('失败'), false);
  assert.equal(toBoolOrNull('说不清'), null);
  assert.equal(clampInt('7', 1, 5, 3), 5);
  assert.equal(clampInt('x', 1, 5, 3), 3);
  assert.equal(clampInt(2.4, 1, 5, 3), 2);
  // 回归：Number(null) === 0，没传参数时必须回退默认值，不能被夹成最小值
  assert.equal(clampInt(null, 1, 500, 50), 50);
  assert.equal(clampInt(undefined, 1, 500, 50), 50);
  assert.equal(clampInt('', 1, 500, 50), 50);
  assert.equal(clampInt(0, 1, 500, 50), 1);
  assert.equal(clampInt('0', 1, 500, 50), 1);
});

test('truncate 超长才截断', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 3), 'abc');
});

/* ----------------------------- 转义 ----------------------------- */

test('escapeHtml 覆盖五个危险字符', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('csvCell 按需加引号', () => {
  assert.equal(csvCell('abc'), 'abc');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell(12), '12');
});

test('escapeLike 转义 SQL LIKE 通配符', () => {
  assert.equal(escapeLike('50%_a\\b'), '50\\%\\_a\\\\b');
  assert.equal(escapeLike('普通文字'), '普通文字');
});

test('safeDecodeURI 遇到非法编码不抛异常', () => {
  assert.equal(safeDecodeURI('%E4%B8%AD%E6%96%87'), '中文');
  assert.equal(safeDecodeURI('%zz'), '%zz');
  assert.equal(safeDecodeURI('100%'), '100%');
});

/* ----------------------------- 结果类型推断 ----------------------------- */

test('looksLikeHtml 只认真正的标记', () => {
  assert.equal(looksLikeHtml('<div class="a">x</div><p>y</p>'), true);
  assert.equal(looksLikeHtml('<!doctype html><html><body>hi</body></html>'), true);
  assert.equal(looksLikeHtml('a < b > c'), false);
  assert.equal(looksLikeHtml('普通文字'), false);
});

test('looksLikeJson 只认能解析的对象 / 数组', () => {
  assert.equal(looksLikeJson('{"a":1}'), true);
  assert.equal(looksLikeJson('[1,2,3]'), true);
  assert.equal(looksLikeJson('{坏掉的}'), false);
  assert.equal(looksLikeJson('"字符串"'), false);
});

test('looksLikeMarkdown 识别标题 / 代码块 / 表格 / 列表', () => {
  assert.equal(looksLikeMarkdown('# 标题\n正文'), true);
  assert.equal(looksLikeMarkdown('```js\nconst a = 1;\n```'), true);
  assert.equal(looksLikeMarkdown('| a | b |\n| --- | --- |'), true);
  assert.equal(looksLikeMarkdown('- 一\n- 二'), true);
  assert.equal(looksLikeMarkdown('就是一段普通回答'), false);
});

test('inferResultType 按内容推断，显式提示优先', () => {
  assert.equal(inferResultType('<div>a</div><p>b</p>'), 'html');
  assert.equal(inferResultType('{"a":1}'), 'json');
  assert.equal(inferResultType('# 标题\n\n正文'), 'markdown');
  assert.equal(inferResultType('https://example.com/a.png'), 'image');
  assert.equal(inferResultType('data:image/png;base64,AAAA'), 'image');
  assert.equal(inferResultType('一段普通的文字回答。'), 'text');
  assert.equal(inferResultType('随便什么', 'html'), 'html');
  assert.equal(inferResultType('随便什么', 'md'), 'markdown');
  assert.equal(inferResultType('', ''), 'text');
});

test('文件型结果能被识别（图片优先于普通文件）', () => {
  assert.equal(inferResultType('/files/abc.png'), 'image');
  assert.equal(inferResultType('/files/report.pdf'), 'file');
  assert.equal(inferResultType('/files/data.zip'), 'file');
  assert.equal(inferResultType('/files/whatever'), 'file');
  assert.equal(inferResultType('https://example.com/a.pdf'), 'file');
  assert.equal(inferResultType('https://example.com/a.png'), 'image');
  assert.equal(inferResultType('随便什么', 'file'), 'file');
  assert.equal(inferResultType('随便什么', 'attachment'), 'file');
});

test('deriveTitle 取提示词首个非空行并去掉前缀', () => {
  assert.equal(deriveTitle('\n\n# 我的测试\n正文', ''), '我的测试');
  assert.equal(deriveTitle('  - 列表项说明  ', ''), '列表项说明');
  assert.equal(deriveTitle('', '<div>结果</div>'), '<div>结果</div>');
  assert.equal(deriveTitle('', ''), '');
  assert.equal(deriveTitle('x'.repeat(200), '').length, 81);
});
