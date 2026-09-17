// 端到端接口测试：真启动一个 server.mjs 子进程，用 fetch 打全部接口
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-api-'));
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let child = null;
let base = '';

function startServer() {
  return new Promise((resolve, reject) => {
    // --port 0：让系统分配空闲端口，多文件并行跑也不会撞端口
    const proc = spawn(process.execPath, [SERVER, '--port', '0', '--data-dir', DATA_DIR, '--no-seed'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`服务启动超时：\n${output}`));
    }, 20000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, base: match[1] });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`服务提前退出 code=${code}\n${output}`));
    });
  });
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const parse = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text };
  }
};

async function createRecord(body) {
  const res = await fetch(`${base}/api/records`, json(body));
  const data = await parse(res);
  assert.equal(res.status, 201, `登记应返回 201，实际 ${res.status}：${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
  return data;
}

before(async () => {
  const started = await startServer();
  child = started.proc;
  base = started.base;
});

after(async () => {
  if (child && !child.killed) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('静态界面与健康检查', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /模型测试记录台/);

  const app = await fetch(`${base}/app.js`);
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.backend, 'sqlite');
  assert.equal(typeof health.server_time_local, 'string');
  assert.match(health.timezone_offset, /^[+-]\d{2}:\d{2}$/);
});

test('CORS 预检放行，接口无需鉴权', async () => {
  const preflight = await fetch(`${base}/api/records`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

  // 不带任何 token 直接写
  const res = await fetch(`${base}/api/records`, json({ model: 'm', prompt: 'p', result: 'r' }));
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('登记最小记录：返回 id / 时间 / 结果页地址', async () => {
  const before = Date.now();
  const data = await createRecord({
    model: 'gpt-5.1',
    prompt: '用三句话解释 RAG',
    result: '第一句……',
    tags: ['rag', '文本'],
    latency_ms: 1840,
    tokens_in: 62,
    tokens_out: 208,
    cost: 0.0003,
  });
  assert.match(data.id, /^rec_/);
  assert.equal(data.model, 'gpt-5.1');
  assert.equal(data.result_type, 'text');
  assert.equal(data.title, '用三句话解释 RAG');
  assert.equal(data.url, `${base}/r/${data.id}`);
  assert.match(data.created_at_local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const created = Date.parse(data.created_at);
  assert.ok(created >= before - 5000 && created <= Date.now() + 1000);

  const one = await (await fetch(`${base}/api/records/${data.id}`)).json();
  assert.equal(one.record.tokens_in, 62);
  assert.equal(one.record.tokens_out, 208);
  assert.equal(one.record.total_tokens, 270, '只给 in/out 时服务端要自动求和');
  assert.deepEqual(one.record.tags, ['rag', '文本']);
  assert.equal(one.record.latency_ms, 1840);
});

test('幂等键：同一 request_id 重复提交不会写两条', async () => {
  const body = { request_id: 'api-idem-1', model: 'm', prompt: '幂等', result: '第一次' };
  const first = await createRecord(body);
  assert.equal(first.duplicate, false);

  const res = await fetch(`${base}/api/records`, json(body));
  const second = await parse(res);
  assert.equal(res.status, 200, '重复提交返回 200 而不是 201');
  assert.equal(second.duplicate, true);
  assert.equal(second.id, first.id);

  const list = await (await fetch(`${base}/api/records?q=幂等`)).json();
  assert.equal(list.total, 1);
});

test('HTML 结果：列表里可查，/r/:id 直接以网页输出', async () => {
  const html = '<!doctype html><html><head><title>t</title></head><body><h1>测试渲染</h1><script>1+1</script></body></html>';
  const data = await createRecord({ model: 'gpt-5.1-codex', prompt: '做个卡片', result_type: 'html', result: html });
  assert.equal(data.result_type, 'html');

  const page = await fetch(`${base}/r/${data.id}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /测试渲染/);

  const raw = await fetch(`${base}/r/${data.id}?raw=1`);
  assert.equal(await raw.text(), html, 'raw=1 应原样输出结果本身');

  const download = await fetch(`${base}/r/${data.id}?download=1`);
  assert.match(download.headers.get('content-disposition') || '', /attachment/);

  const missing = await fetch(`${base}/r/rec_不存在`);
  assert.equal(missing.status, 404);
});

test('text/plain 正文 + query 传字段', async () => {
  const res = await fetch(
    `${base}/api/records?model=gpt-5.1&prompt=${encodeURIComponent('做个落地页')}&result_type=html`,
    { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '<div>landing</div><p>ok</p>' },
  );
  const data = await parse(res);
  assert.equal(res.status, 201);

  const one = await (await fetch(`${base}/api/records/${data.id}`)).json();
  assert.equal(one.record.result, '<div>landing</div><p>ok</p>');
  assert.equal(one.record.model, 'gpt-5.1');
  assert.equal(one.record.prompt, '做个落地页');
  assert.equal(one.record.result_type, 'html');
});

test('多段结果（text + html）会存成 parts', async () => {
  const data = await createRecord({
    model: 'claude-sonnet-5',
    prompt: '先结论再卡片',
    parts: [
      { type: 'text', label: '结论', content: '差距不大。' },
      { type: 'html', label: '卡片', content: '<b>A vs B</b>' },
    ],
  });
  assert.equal(data.result_type, 'mixed');
  const one = await (await fetch(`${base}/api/records/${data.id}`)).json();
  assert.equal(one.record.parts.length, 2);
  assert.equal(one.record.parts[1].label, '卡片');
});

test('批量登记数组', async () => {
  const res = await fetch(
    `${base}/api/records`,
    json([
      { model: 'm1', prompt: '1+1=?（批量）', result: '2' },
      { model: 'm2', prompt: '1+1=?（批量）', result: '二' },
    ]),
  );
  const data = await parse(res);
  assert.equal(res.status, 201);
  assert.equal(data.created, 2);
  assert.equal(data.ids.length, 2);
});

test('列表筛选 / 排序 / 分页 / 总数头', async () => {
  const res = await fetch(`${base}/api/records?limit=2&order=asc`);
  const data = await parse(res);
  assert.equal(res.headers.get('x-total-count'), String(data.total));
  assert.equal(data.items.length, 2);
  assert.ok(data.total >= 2);
  assert.ok(data.items[0].created_at_ms <= data.items[1].created_at_ms);

  const byModel = await (await fetch(`${base}/api/records?model=gpt-5.1-codex`)).json();
  assert.ok(byModel.total >= 1);
  assert.ok(byModel.items.every((r) => r.model === 'gpt-5.1-codex'));

  const byType = await (await fetch(`${base}/api/records?type=html`)).json();
  assert.ok(byType.items.every((r) => r.result_type === 'html'));

  const byQ = await (await fetch(`${base}/api/records?q=${encodeURIComponent('测试渲染')}`)).json();
  assert.ok(byQ.total >= 1);

  // 回归：不传 limit 时必须用默认 50，而不是被 Number(null)=0 夹成 1
  const defaultPage = await (await fetch(`${base}/api/records`)).json();
  assert.equal(defaultPage.limit, 50);
  assert.ok(defaultPage.items.length > 1, `默认分页不应只返回 1 条，实际 ${defaultPage.items.length}`);
});

test('PATCH 更新标题 / 标签 / 批次 / 备注', async () => {
  const created = await createRecord({ model: 'm', prompt: 'p', result: 'r' });
  const res = await fetch(`${base}/api/records/${created.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '改过的标题', tags: 'a,b', batch: 'API 批次', note: '手工备注' }),
  });
  const data = await parse(res);
  assert.equal(res.status, 200);
  assert.equal(data.record.title, '改过的标题');
  assert.deepEqual(data.record.tags, ['a', 'b']);
  assert.equal(data.record.batch_name, 'API 批次');
  assert.ok(data.record.batch_id, '批次名不存在时应自动建批次');
  assert.equal(data.record.meta.note, '手工备注');

  const batch = await (await fetch(`${base}/api/records?batch=${encodeURIComponent('API 批次')}`)).json();
  assert.equal(batch.total, 1);

  const facets = await (await fetch(`${base}/api/facets`)).json();
  assert.ok(facets.batches.some((b) => b.name === 'API 批次' && b.count === 1));
});

test('附件清理：被结果引用的不删，没人引用的才删', async () => {
  const upload = async (name) => {
    const res = await fetch(`${base}/api/files?name=${encodeURIComponent(name)}&mime=${encodeURIComponent('image/png')}&raw=1`, {
      method: 'POST',
      body: PNG_1PX,
    });
    return (await parse(res)).attachment;
  };

  // ① 附件就是结果本身 → 摘掉附件后文件必须保留（结果还指着它）
  const resultAtt = await upload('截图.png');
  const resultDisk = path.join(DATA_DIR, resultAtt.path);
  assert.ok(fs.existsSync(resultDisk), '文件应当写到 data/files 下');
  const served = await fetch(`${base}${resultAtt.url}`);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /image\/png/);
  await served.arrayBuffer();

  const created = await createRecord({
    model: 'gpt-image-2',
    prompt: '画一只猫',
    result_type: 'image',
    result: resultAtt.url,
    attachments: [resultAtt],
  });
  const withAtt = (await (await fetch(`${base}/api/records/${created.id}`)).json()).record;
  assert.equal(withAtt.attachments.length, 1);

  const patched = await (
    await fetch(`${base}/api/records/${created.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [] }),
    })
  ).json();
  assert.equal(patched.record.attachments.length, 0);
  assert.equal(patched.removed_files, 0, '结果还引用着它，不能删文件');
  assert.ok(fs.existsSync(resultDisk));

  // ② 纯附件（结果里没引用）→ 摘掉就删
  const extraAtt = await upload('extra.png');
  const extraDisk = path.join(DATA_DIR, extraAtt.path);
  const created2 = await createRecord({ model: 'm', prompt: '带附件的记录', result: '正文', attachments: [extraAtt] });
  assert.ok(fs.existsSync(extraDisk));
  const patched2 = await (
    await fetch(`${base}/api/records/${created2.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments: [] }),
    })
  ).json();
  assert.equal(patched2.removed_files, 1);
  assert.equal(fs.existsSync(extraDisk), false, '没人引用的附件文件应当被删掉');

  // ③ 删掉记录 → ① 的文件型结果这时才被清理
  await fetch(`${base}/api/records/${created.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(resultDisk), false);
});

test('删除记录会连带删除它的附件', async () => {
  const upload = await fetch(`${base}/api/files?name=temp.txt&raw=1`, { method: 'POST', body: Buffer.from('temp') });
  const att = (await parse(upload)).attachment;
  const diskFile = path.join(DATA_DIR, att.path);

  const created = await createRecord({ model: 'm', prompt: 'p', result: 'r', attachments: [att] });
  assert.ok(fs.existsSync(diskFile));

  const del = await fetch(`${base}/api/records/${created.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(diskFile), false);

  const again = await fetch(`${base}/api/records/${created.id}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('multipart 上传文件：文件直接成为结果，不是附件', async () => {
  // ① HTML 文件 → 内容变成结果正文
  const form = new FormData();
  form.set('model', 'gpt-5.1');
  form.set('prompt', '生成一份报告');
  form.set('result', new Blob(['<h1>报告</h1><p>内容</p>'], { type: 'text/html' }), 'report.html');
  const res = await fetch(`${base}/api/records`, { method: 'POST', body: form });
  const data = await parse(res);
  assert.equal(res.status, 201, JSON.stringify(data));
  const htmlRec = (await (await fetch(`${base}/api/records/${data.id}`)).json()).record;
  assert.equal(htmlRec.result, '<h1>报告</h1><p>内容</p>');
  assert.equal(htmlRec.result_type, 'html');
  assert.equal(htmlRec.attachments.length, 0, 'HTML 文件不该被当成附件');
  assert.match(await (await fetch(`${base}/r/${data.id}`)).text(), /<h1>报告<\/h1>/);

  // ② 二进制文件（字段名 file）→ 存成文件结果
  const form2 = new FormData();
  form2.set('model', 'gpt-image-2');
  form2.set('prompt', '画一只猫');
  form2.set('file', new Blob([PNG_1PX], { type: 'image/png' }), 'cat.png');
  const res2 = await fetch(`${base}/api/records`, { method: 'POST', body: form2 });
  const data2 = await parse(res2);
  assert.equal(res2.status, 201, JSON.stringify(data2));
  const fileRec = (await (await fetch(`${base}/api/records/${data2.id}`)).json()).record;
  assert.equal(fileRec.result_type, 'image');
  assert.match(fileRec.result, /^\/files\//);
  assert.equal(fileRec.attachments.length, 0, '二进制文件也不该被塞进附件');

  const fileUrl = fileRec.result;
  const diskFile = path.join(DATA_DIR, 'files', decodeURIComponent(fileUrl.slice('/files/'.length)));
  assert.ok(fs.existsSync(diskFile));

  // 结果页应当把它当图片渲染，而不是丢一段 <pre>
  const page = await (await fetch(`${base}/r/${data2.id}`)).text();
  assert.match(page, /<img src="\/files\//);

  // ?download=1 应当把文件本体的字节吐回来
  const download = await fetch(`${base}/r/${data2.id}?download=1`);
  assert.match(download.headers.get('content-type'), /image\/png/);
  assert.equal((await download.arrayBuffer()).byteLength, PNG_1PX.length);

  // 删记录时这个「文件型结果」也要被清掉
  await fetch(`${base}/api/records/${data2.id}`, { method: 'DELETE' });
  assert.equal(fs.existsSync(diskFile), false, '删除记录应连带清掉文件型结果的文件');

  // ③ 第三方文件字段名仍然作为附件
  const form3 = new FormData();
  form3.set('model', 'm');
  form3.set('prompt', '带附件的记录');
  form3.set('result', '正文');
  form3.set('attachments', new Blob([PNG_1PX], { type: 'image/png' }), 'shot.png');
  const res3 = await fetch(`${base}/api/records`, { method: 'POST', body: form3 });
  const data3 = await parse(res3);
  const rec3 = (await (await fetch(`${base}/api/records/${data3.id}`)).json()).record;
  assert.equal(rec3.result, '正文');
  assert.equal(rec3.attachments.length, 1, 'attachments 字段应当仍然是附件');
});

test('统计与导出', async () => {
  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(stats.ok, true);
  assert.equal(stats.backend, 'sqlite');
  assert.equal(stats.series.length, 14);
  assert.ok(stats.total >= 5);
  assert.equal(typeof stats.uptime_seconds, 'number');

  const csv = await fetch(`${base}/api/export?format=csv`);
  const csvText = await csv.text();
  assert.match(csvText, /id,created_at,created_at_local/);
  assert.match(csvText, /用三句话解释 RAG/);

  const ndjson = await fetch(`${base}/api/export?format=ndjson`);
  const lines = (await ndjson.text()).trim().split('\n');
  assert.ok(lines.length >= 5);
  assert.ok(JSON.parse(lines[0]).id);

  const exported = await (await fetch(`${base}/api/export?format=json`)).json();
  assert.equal(exported.ok, true);
  assert.equal(exported.records.length, exported.count);

  const filtered = await (await fetch(`${base}/api/export?format=json&model=gpt-5.1-codex`)).json();
  assert.ok(filtered.records.every((r) => r.model === 'gpt-5.1-codex'));
});

test('/api/help 自描述与 404 行为', async () => {
  const help = await (await fetch(`${base}/api/help`)).json();
  assert.equal(help.auth, 'none');
  assert.ok(help.endpoints.some((e) => e.path === '/api/records' && e.method === 'POST'));
  assert.ok(help.field_aliases.prompt.includes('input'));
  assert.ok(help.field_aliases.attachments.includes('image_url'));

  const missing = await fetch(`${base}/api/不存在的接口`);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /未知接口/);
});

test('坏请求体给出明确的 4xx 而不是 500', async () => {
  const bad = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{不是合法 JSON',
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /JSON/);

  const huge = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'x'.repeat(40 * 1024 * 1024) }),
  });
  assert.equal(huge.status, 413);
});
