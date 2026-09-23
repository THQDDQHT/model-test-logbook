// 前端静态资源自检：语法、id 引用一致性、样式括号配平
// 这些检查不需要浏览器，但能挡住「改了 HTML 忘了改 JS」这类低级错误。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'public', 'index.html');
const APP = path.join(ROOT, 'public', 'app.js');
const STYLES = path.join(ROOT, 'public', 'styles.css');

const html = fs.readFileSync(INDEX, 'utf8');
const js = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(STYLES, 'utf8');

// 表单里这些节点是 JS 动态生成后插进 #modalRoot 的，不在 index.html 的静态 HTML 里
const DYNAMIC_IDS = new Set([
  'f-title',
  'f-prompt',
  'f-model',
  'f-reasoning',
  'f-harness',
  'f-type',
  'f-result',
  'f-tags',
  'f-batch',
  'f-latency',
  'f-tokens',
  'f-time',
  'f-note',
  'uploadSection',
  'uploadList',
  'resultDrop',
  'resultPreview',
  'dropzone',
  'resultFileInput',
  'attachFileInput',
]);

test('public/app.js 语法正确（ESM 解析通过）', () => {
  const result = spawnSync(process.execPath, ['--check', APP], { encoding: 'utf8' });
  assert.equal(result.status, 0, `app.js 解析失败：\n${result.stderr || result.stdout}`);
});

test('app.js 里 $("#id") 用到的节点都存在', () => {
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id) && !DYNAMIC_IDS.has(id));
  assert.deepEqual(missing, [], `这些 id 谁都找不到：#${missing.join(' #')}`);
});

test('动态节点的 id 在 app.js 里确实被创建', () => {
  const missing = [...DYNAMIC_IDS].filter((id) => !js.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `白名单里的 id 其实没被生成：#${missing.join(' #')}`);
});

test('index.html 引用的静态资源都存在', () => {
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('//'));
  const files = refs.filter((u) => /\.(js|css)$/.test(u));
  assert.ok(files.length >= 2, 'index.html 应当引用 app.js 与 styles.css');
  for (const url of files) {
    assert.ok(fs.existsSync(path.join(ROOT, 'public', url.replace(/^\//, ''))), `静态文件不存在：${url}`);
  }
});

test('styles.css 括号配平', () => {
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  assert.equal(open, close, `花括号不配平：{ ${open} 个，} ${close} 个`);
  assert.ok(open > 100, 'styles.css 看起来不像被写坏了');
});

test('app.js 模板字符串的反引号成对', () => {
  // 注意：不能用「反引号总数是偶数」来判断——正则字面量里也会出现反引号。
  // 真正靠谱的是上面的 node --check；这里只保留一条明确的结构断言。
  assert.ok(js.includes('${esc('), 'app.js 里应当有正常的模板插值');
  const result = spawnSync(process.execPath, ['--check', APP], { encoding: 'utf8' });
  assert.equal(result.status, 0, `模板字符串有问题：\n${result.stderr || result.stdout}`);
});

test('前端已接上「文件即结果」的入口', () => {
  // 先把注释去掉，否则会误伤代码里提到这些写法的说明文字
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(js.includes('id="resultDrop"'), '结果区应当有拖拽/选择文件的入口');
  assert.ok(js.includes('id="resultFileInput"'), '结果区应当内嵌一个原生 file input');
  assert.ok(js.includes('class="file-overlay"'), 'file input 应当铺满整条区域（file-overlay）');
  assert.ok(css.includes('.file-overlay'), '缺少 file-overlay 的样式');
  assert.ok(!/\b(?:resultInput|attachInput|fileInput|input)\.click\(\)/.test(code), '不应该再靠 JS 唤起文件选择器');
  assert.ok(!code.includes('hiddenFileInput'), '不应该再有隐藏的共享 file input');
  assert.ok(js.includes('setResultFile'), '缺少把文件变成结果的逻辑');
  assert.ok(css.includes('.file-card'), '缺少文件型结果的样式');
  assert.ok(css.includes('.file-preview'), '缺少文件预览的样式');
});
