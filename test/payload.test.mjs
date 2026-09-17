// lib/payload.mjs 的单元测试：登记接口的字段归一化
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeRecordPayload, normalizeBatchPayload } from '../lib/payload.mjs';

// 1x1 的合法 PNG，用来验证 base64 附件落盘
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-payload-'));
}

function norm(input, dir = tmpDir()) {
  return normalizeRecordPayload(input, { dataDir: dir });
}

test('常见字段别名都能正确识别', () => {
  const { record } = norm({
    input: '提示词内容',
    output: '模型结果',
    model_name: 'gpt-test',
    vendor: 'openai',
    duration: 1200,
    prompt_tokens: 10,
    completion_tokens: 5,
    request_id: 'req-1',
    labels: 'a,b',
    state: 'success',
    time: 1758089292,
  });
  assert.equal(record.prompt, '提示词内容');
  assert.equal(record.result, '模型结果');
  assert.equal(record.model, 'gpt-test');
  assert.equal(record.provider, 'openai');
  assert.equal(record.latency_ms, 1200);
  assert.equal(record.tokens_in, 10);
  assert.equal(record.tokens_out, 5);
  assert.equal(record.total_tokens, 15, '只给 in/out 时应自动求和');
  assert.equal(record.idempotency_key, 'req-1');
  assert.deepEqual(record.tags, ['a', 'b']);
  assert.equal(record.status, 'ok');
  assert.equal(record.created_at_ms, 1758089292000, '10 位时间戳按秒处理');
});

test('未识别的字段原样收进 meta._extra，不丢数据', () => {
  const { record } = norm({
    model: 'm',
    result: 'r',
    我自己加的字段: 42,
    nested: { a: 1 },
    temperature: 0.7,
  });
  assert.equal(record.meta._extra['我自己加的字段'], 42);
  assert.deepEqual(record.meta._extra.nested, { a: 1 });
  assert.equal(record.meta._extra.temperature, 0.7);
  assert.equal(record.meta._extra.model, undefined, '已识别的字段不应出现在 _extra');
});

test('meta / metadata / extra 会被合并，note 进 meta.note', () => {
  const { record } = norm({ model: 'm', result: 'r', metadata: { 跑分: 91 }, note: '这条失败了' });
  assert.equal(record.meta['跑分'], 91);
  assert.equal(record.meta.note, '这条失败了');
});

test('同时给 text 与 html 会变成两段结果', () => {
  const { record } = norm({ model: 'm', text: '先给结论', html: '<b>卡片</b>' });
  assert.equal(record.result_type, 'mixed');
  assert.equal(record.parts.length, 2);
  assert.equal(record.parts[0].type, 'text');
  assert.equal(record.parts[0].content, '先给结论');
  assert.equal(record.parts[1].type, 'html');
  assert.equal(record.parts[1].content, '<b>卡片</b>');
  assert.match(record.result, /卡片/);
});

test('parts 数组按段保留，可以带 label', () => {
  const { record } = norm({
    parts: [
      { type: 'text', content: 'A 段' },
      { type: 'html', label: '卡片', content: '<b>B</b>' },
    ],
  });
  assert.equal(record.parts.length, 2);
  assert.equal(record.parts[1].label, '卡片');
  assert.equal(record.result_type, 'mixed');
});

test('result_type 不传时按内容自动推断', () => {
  assert.equal(norm({ result: '<div>a</div><p>b</p>' }).record.result_type, 'html');
  assert.equal(norm({ result: '{"a":1}' }).record.result_type, 'json');
  assert.equal(norm({ result: '# 标题\n\n正文' }).record.result_type, 'markdown');
  assert.equal(norm({ result: '一段普通回答。' }).record.result_type, 'text');
  assert.equal(norm({ result: 'https://a.com/b.png' }).record.result_type, 'image');
  assert.equal(norm({ result: '随便', format: 'html' }).record.result_type, 'html');
});

test('ok:false / error / status 中文都能判成失败', () => {
  assert.equal(norm({ result: 'x', ok: false }).record.status, 'error');
  assert.equal(norm({ result: 'x', success: false }).record.status, 'error');
  assert.equal(norm({ result: 'x', error: '请求超时' }).record.status, 'error');
  assert.equal(norm({ result: 'x', status: '失败' }).record.status, 'error');
  assert.equal(norm({ result: 'x', status: '成功' }).record.status, 'ok');
  assert.equal(norm({ result: 'x' }).record.status, 'ok');
});

test('created_at 无法解析时回退当前时间并留痕', () => {
  const { record, warnings } = norm({ result: 'x', created_at: '昨天下午' });
  assert.ok(warnings.some((w) => w.includes('created_at')));
  assert.equal(record.meta._unparsed_created_at, '昨天下午');
  assert.ok(Math.abs(record.created_at_ms - Date.now()) < 5000);
});

test('data URL 附件会落盘，并产出可访问的 /files url', () => {
  const dir = tmpDir();
  const { record } = norm({ result: 'x', attachments: [{ name: '评分卡.png', data_url: `data:image/png;base64,${PNG_1PX}` }] }, dir);
  assert.equal(record.attachments.length, 1);
  const att = record.attachments[0];
  assert.equal(att.kind, 'image');
  assert.equal(att.mime, 'image/png');
  assert.match(att.url, /^\/files\//);
  assert.equal(att.remote, false);
  assert.ok(fs.existsSync(path.join(dir, att.path)), '附件应当真的写到 data/files 下');
});

test('纯文本附件会按文本落盘', () => {
  const dir = tmpDir();
  const { record } = norm({ result: 'x', attachments: [{ name: 'log.txt', content: 'hello' }] }, dir);
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].kind, 'file');
  assert.equal(fs.readFileSync(path.join(dir, record.attachments[0].path), 'utf8'), 'hello');
});

test('远程 url 附件只记引用，不落盘', () => {
  const { record } = norm({ result: 'x', image_url: 'https://example.com/a.png' });
  assert.equal(record.attachments.length, 1);
  assert.equal(record.attachments[0].remote, true);
  assert.equal(record.attachments[0].path, '');
  assert.equal(record.attachments[0].url, 'https://example.com/a.png');
});

test('已落盘的 /files 引用会被原样保留（含中文文件名）', () => {
  const dir = tmpDir();
  const created = norm({ result: 'x', attachments: [{ name: '中文名字.txt', content: 'hi' }] }, dir).record;
  const first = created.attachments[0];
  const { record } = norm({ result: 'y', attachments: [{ name: first.name, url: first.url, mime: first.mime, size: first.size }] }, dir);
  assert.equal(record.attachments[0].url, first.url);
  assert.equal(record.attachments[0].path, first.path, '中文文件名反解出的磁盘路径必须和写入时一致');
});

test('图片型结果如果是 base64，会落盘并换成 url', () => {
  const dir = tmpDir();
  const { record } = norm({ result_type: 'image', result: `data:image/png;base64,${PNG_1PX}` }, dir);
  assert.match(record.result, /^\/files\//);
  assert.equal(record.attachments.length, 1);
  assert.ok(fs.existsSync(path.join(dir, record.attachments[0].path)));
});

test('messages 数组会拼成可读提示词，原文保留在 meta', () => {
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ];
  const { record } = norm({ messages });
  assert.match(record.prompt, /\[system\]/);
  assert.match(record.prompt, /你好/);
  assert.deepEqual(record.meta.messages, messages);
});

test('标题优先用显式值，其次取提示词首行', () => {
  assert.equal(norm({ title: '指定标题', prompt: '别的' }).record.title, '指定标题');
  assert.equal(norm({ prompt: '\n\n# 我的测试\n正文' }).record.title, '我的测试');
  assert.equal(norm({ prompt: '', result: '第一行结果\n第二行' }).record.title, '第一行结果');
});

test('批次名与批次 id、标签、成本字段', () => {
  const { record } = norm({ batch: ' 2026-09-17 UI 对比 ', batch_id: 'bat_x', tags: ['对比', 'UI'], cost: '0.0123', currency: 'CNY' });
  assert.equal(record.batch_name, '2026-09-17 UI 对比');
  assert.equal(record.batch_id, 'bat_x');
  assert.deepEqual(record.tags, ['对比', 'UI']);
  assert.equal(record.cost, 0.0123);
  assert.equal(record.currency, 'CNY');
});

test('字符串请求体按结果内容处理', () => {
  const { record } = norm('就是一段纯文本结果');
  assert.equal(record.result, '就是一段纯文本结果');
  assert.equal(record.result_type, 'text');
});

test('空记录只给提示，不报错', () => {
  const { record, warnings } = norm({});
  assert.equal(record.result, '');
  assert.ok(warnings.length >= 1);
  assert.match(record.id, /^rec_/);
});

test('非对象请求体会抛 400', () => {
  assert.throws(() => norm(42), (err) => err.status === 400);
});

test('结果本身就是一个文件时，类型推断为 file / image', () => {
  assert.equal(norm({ result: '/files/report.pdf' }).record.result_type, 'file');
  assert.equal(norm({ result: '/files/page.png' }).record.result_type, 'image');
  assert.equal(norm({ result: 'https://example.com/a.zip' }).record.result_type, 'file');
  // 显式指定仍然优先
  assert.equal(norm({ result: '/files/report.pdf', result_type: 'text' }).record.result_type, 'text');
});

test('normalizeBatchPayload 的必填校验与别名', () => {
  assert.throws(() => normalizeBatchPayload({}), /name/);
  assert.equal(normalizeBatchPayload({ batch_name: '批次A' }).name, '批次A');
  assert.equal(normalizeBatchPayload({ title: '批次B' }).name, '批次B');
  assert.equal(normalizeBatchPayload({ name: '批次C', note: '备注' }).note, '备注');
});
