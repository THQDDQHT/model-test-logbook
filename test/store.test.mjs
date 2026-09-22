// lib/store.mjs 的单元测试：存储、筛选、批次、附件回收
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openStore } from '../lib/store.mjs';
import { normalizeRecordPayload } from '../lib/payload.mjs';
import { saveFile } from '../lib/files.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-store-'));
}

/** 造一条字段完整的记录 */
function makeRecord(overrides = {}) {
  const ms = overrides.created_at_ms === undefined ? Date.now() : overrides.created_at_ms;
  const iso = new Date(ms).toISOString();
  return {
    id: overrides.id || `rec_${Math.random().toString(36).slice(2, 10)}`,
    title: '标题',
    prompt: '提示词',
    model: 'model-a',
    provider: '',
    reasoning_effort: '',
    harness: '',
    batch_id: null,
    batch_name: '',
    tags: [],
    status: 'ok',
    result_type: 'text',
    result: '结果',
    parts: [],
    error: '',
    latency_ms: null,
    tokens_in: null,
    tokens_out: null,
    total_tokens: null,
    cost: null,
    currency: '',
    meta: {},
    attachments: [],
    source: 'test',
    idempotency_key: null,
    created_at: iso,
    created_at_ms: ms,
    updated_at: iso,
    updated_at_ms: ms,
    ...overrides,
  };
}

test('打开存储：默认使用 SQLite 后端并建好目录', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  assert.equal(store.backend, 'sqlite');
  assert.ok(fs.existsSync(path.join(dir, 'records.db')));
  assert.ok(fs.existsSync(path.join(dir, 'files')));
  store.close();
});

test('旧 SQLite 数据库会自动补齐 reasoning_effort 与 harness 列', async () => {
  const dir = tmpDir();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'records.db'));
  db.exec(`
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      title TEXT,
      prompt TEXT,
      model TEXT,
      provider TEXT,
      batch_id TEXT,
      batch_name TEXT,
      tags TEXT,
      status TEXT,
      result_type TEXT,
      result TEXT,
      parts TEXT,
      error TEXT,
      latency_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      total_tokens INTEGER,
      cost REAL,
      currency TEXT,
      meta TEXT,
      attachments TEXT,
      source TEXT,
      idempotency_key TEXT,
      created_at TEXT,
      created_at_ms INTEGER,
      updated_at TEXT,
      updated_at_ms INTEGER
    );
    INSERT INTO records (id, title, model, status, result_type, result, created_at, created_at_ms)
    VALUES ('old', '旧记录', 'old-model', 'ok', 'text', 'ok', '1970-01-01T00:00:01.000Z', 1000);
  `);
  db.close();

  const store = await openStore(dir);
  assert.equal(store.backend, 'sqlite');
  assert.equal(store.getRecord('old').reasoning_effort, '');
  assert.equal(store.getRecord('old').harness, '');
  store.insertRecord(makeRecord({ id: 'new', reasoning_effort: 'high', harness: 'codex' }));
  assert.equal(store.getRecord('new').reasoning_effort, 'high');
  assert.equal(store.getRecord('new').harness, 'codex');
  store.close();
});

test('写入 / 读取 / 默认倒序 / 分页', async () => {
  const store = await openStore(tmpDir());
  store.insertRecord(makeRecord({ id: 'r1', created_at_ms: 1000 }));
  store.insertRecord(makeRecord({ id: 'r2', created_at_ms: 3000 }));
  store.insertRecord(makeRecord({ id: 'r3', created_at_ms: 2000 }));

  const desc = store.listRecords({});
  assert.equal(desc.total, 3);
  assert.deepEqual(desc.items.map((r) => r.id), ['r2', 'r3', 'r1']);
  assert.equal(desc.items[0].created_at_local.length, 19);

  const asc = store.listRecords({ order: 'asc' });
  assert.deepEqual(asc.items.map((r) => r.id), ['r1', 'r3', 'r2']);

  const page = store.listRecords({ limit: 2, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items.map((r) => r.id), ['r3', 'r1']);

  store.close();
});

test('筛选：关键词 / 模型 / 标签 / 批次 / 类型 / 状态 / 时间范围', async () => {
  const store = await openStore(tmpDir());
  store.insertRecord(
    makeRecord({
      id: 'a',
      model: 'gpt-5.1',
      tags: ['对比', '数学'],
      result_type: 'html',
      status: 'ok',
      reasoning_effort: 'high',
      harness: 'codex',
      result: '<div>数学题解</div><p>2</p>',
      created_at_ms: 1000,
    }),
  );
  store.insertRecord(
    makeRecord({
      id: 'b',
      model: 'claude',
      tags: ['对比'],
      result_type: 'text',
      status: 'error',
      reasoning_effort: 'low',
      harness: 'claude-code',
      result: '超时了',
      created_at_ms: 5000,
    }),
  );
  store.insertRecord(
    makeRecord({ id: 'c', model: 'gpt-5.1', tags: [], result_type: 'text', reasoning_effort: 'high', harness: 'codex', created_at_ms: 9000 }),
  );

  assert.deepEqual(store.listRecords({ model: 'gpt-5.1' }).items.map((r) => r.id).sort(), ['a', 'c']);
  assert.deepEqual(store.listRecords({ tags: ['对比'] }).items.map((r) => r.id).sort(), ['a', 'b']);
  assert.deepEqual(store.listRecords({ tags: ['对比', '数学'] }).items.map((r) => r.id), ['a']);
  assert.deepEqual(store.listRecords({ result_type: 'html' }).items.map((r) => r.id), ['a']);
  assert.deepEqual(store.listRecords({ status: 'error' }).items.map((r) => r.id), ['b']);
  assert.deepEqual(store.listRecords({ reasoning_effort: ['high'] }).items.map((r) => r.id).sort(), ['a', 'c']);
  assert.deepEqual(store.listRecords({ harness: ['codex'] }).items.map((r) => r.id).sort(), ['a', 'c']);
  assert.deepEqual(store.listRecords({ reasoning_effort: ['high'], harness: ['claude-code'] }).total, 0);
  assert.deepEqual(store.listRecords({ q: 'claude' }).items.map((r) => r.id), ['b'], '关键词应能命中模型名');
  assert.deepEqual(store.listRecords({ q: '数学题解' }).items.map((r) => r.id), ['a'], '关键词应能命中结果正文');
  assert.deepEqual(store.listRecords({ from_ms: 4000, to_ms: 8000 }).items.map((r) => r.id), ['b']);
  assert.deepEqual(store.listRecords({ ids: ['a', 'c'] }).items.map((r) => r.id).sort(), ['a', 'c']);
  assert.equal(store.listRecords({ model: '不存在的模型' }).total, 0);

  // LIKE 通配符应被转义，不能把 % 当成任意字符
  assert.equal(store.listRecords({ q: '%' }).total, 0);

  // ?batch= 既接受批次名也接受批次 id；batch_id 是严格 id
  const batch = store.createBatch({ name: '批次筛选' });
  store.insertRecord(makeRecord({ id: 'd', batch_id: batch.id, batch_name: '批次筛选' }));
  assert.deepEqual(store.listRecords({ batch: '批次筛选' }).items.map((r) => r.id), ['d']);
  assert.deepEqual(store.listRecords({ batch: batch.id }).items.map((r) => r.id), ['d']);
  assert.deepEqual(store.listRecords({ batch_id: batch.id }).items.map((r) => r.id), ['d']);
  assert.equal(store.listRecords({ batch_id: '批次筛选' }).total, 0);

  // 不传 limit 时用默认值 50，而不是被夹成 1
  assert.equal(store.listRecords({}).limit, 50);

  store.close();
});

test('幂等键：重复写入只返回已存在的那条', async () => {
  const store = await openStore(tmpDir());
  store.insertRecord(makeRecord({ id: 'r1', idempotency_key: 'run-1' }));
  assert.equal(store.findByIdempotencyKey('run-1').id, 'r1');
  assert.equal(store.findByIdempotencyKey('run-2'), null);
  assert.equal(store.findByIdempotencyKey(''), null);
  store.close();
});

test('更新记录后能读回新值', async () => {
  const store = await openStore(tmpDir());
  store.insertRecord(makeRecord({ id: 'r1' }));
  const updated = store.updateRecord('r1', { title: '新标题', tags: ['x'], meta: { note: '备注' } });
  assert.equal(updated.title, '新标题');
  assert.deepEqual(updated.tags, ['x']);
  assert.equal(updated.meta.note, '备注');
  assert.equal(store.getRecord('r1').title, '新标题');
  assert.equal(store.updateRecord('不存在', { title: 'x' }), null);
  store.close();
});

test('删除记录会顺手清掉没人引用的附件文件', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  const { record } = normalizeRecordPayload(
    { id: 'r1', result: 'x', attachments: [{ name: 'log.txt', content: 'hello' }] },
    { dataDir: dir },
  );
  store.insertRecord(record);
  const att = record.attachments[0];
  const diskFile = path.join(dir, att.path);
  assert.ok(fs.existsSync(diskFile));

  assert.equal(store.deleteRecord('r1'), true);
  assert.equal(fs.existsSync(diskFile), false, '附件文件应当一起被删除');
  assert.equal(store.deleteRecord('r1'), false, '重复删除返回 false');
  store.close();
});

test('同一个附件被多条记录引用时不会误删', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  const first = normalizeRecordPayload(
    { id: 'r1', result: 'x', attachments: [{ name: 'shot.txt', content: 'hi' }] },
    { dataDir: dir },
  ).record;
  store.insertRecord(first);
  const att = first.attachments[0];

  const second = normalizeRecordPayload(
    { id: 'r2', result: 'y', attachments: [{ name: att.name, url: att.url, mime: att.mime, size: att.size }] },
    { dataDir: dir },
  ).record;
  store.insertRecord(second);

  assert.equal(store.attachmentRefCount(att.url), 2);
  const diskFile = path.join(dir, att.path);
  assert.ok(fs.existsSync(diskFile));

  store.deleteRecord('r1');
  assert.equal(store.attachmentRefCount(att.url), 1);
  assert.ok(fs.existsSync(diskFile), '还有记录引用，文件必须保留');

  store.deleteRecord('r2');
  assert.equal(store.attachmentRefCount(att.url), 0);
  assert.equal(fs.existsSync(diskFile), false, '最后一个引用也没了才删除');
  store.close();
});

test('从记录上摘掉附件后调用 purge 才删文件', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  const { record } = normalizeRecordPayload(
    { id: 'r1', result: 'x', attachments: [{ name: 'a.txt', content: 'aaa' }] },
    { dataDir: dir },
  );
  store.insertRecord(record);
  const att = record.attachments[0];
  const diskFile = path.join(dir, att.path);

  // 记录还挂着它 → 不该删
  assert.equal(store.purgeAttachmentFiles([att]), 0);
  assert.ok(fs.existsSync(diskFile));

  // 摘掉之后再 purge → 删掉
  store.updateRecord('r1', { attachments: [] });
  assert.equal(store.purgeAttachmentFiles([att]), 1);
  assert.equal(fs.existsSync(diskFile), false);

  // 远程附件永远不删本地文件
  assert.equal(store.purgeAttachmentFiles([{ url: 'https://x/y.png', remote: true, path: '' }]), 0);
  store.close();
});

test('文件型结果（result 直接是 /files/xxx）也参与孤儿文件回收', async () => {
  const dir = tmpDir();
  const store = await openStore(dir);
  const file = saveFile(dir, { name: 'report.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-1.4 假的') });
  const diskFile = path.join(dir, file.path);
  assert.ok(fs.existsSync(diskFile));
  assert.deepEqual(store.listRecords({}).total, 0);

  // 两条记录都把同一个文件当作结果
  store.insertRecord(makeRecord({ id: 'f1', result: file.url, result_type: 'file' }));
  store.insertRecord(makeRecord({ id: 'f2', result: file.url, result_type: 'file' }));
  assert.equal(store.attachmentRefCount(file.url), 2, '文件型结果也要算进引用计数');

  store.deleteRecord('f1');
  assert.ok(fs.existsSync(diskFile), '还有记录引用它，文件必须保留');

  store.deleteRecord('f2');
  assert.equal(fs.existsSync(diskFile), false, '删掉最后一条引用后，文件型结果的文件也要清掉');

  // 分段结果里的文件同样算引用
  const file2 = saveFile(dir, { name: 'card.png', mime: 'image/png', buffer: Buffer.from('fake') });
  store.insertRecord(
    makeRecord({ id: 'f3', result: '', result_type: 'mixed', parts: [{ type: 'text', content: '说明' }, { type: 'image', content: file2.url }] }),
  );
  assert.equal(store.attachmentRefCount(file2.url), 1);
  store.deleteRecord('f3');
  assert.equal(fs.existsSync(path.join(dir, file2.path)), false);
  store.close();
});

test('批次：创建 / 按名查找 / 计数 / 重命名同步到记录 / 删除后解除归组', async () => {
  const store = await openStore(tmpDir());
  const batch = store.createBatch({ name: '批次A', note: '第一次对比' });
  assert.ok(batch.id);
  assert.equal(store.findBatchByName('批次A').id, batch.id);
  assert.equal(store.findBatchByName('不存在的批次'), null);

  store.insertRecord(makeRecord({ id: 'r1', batch_id: batch.id, batch_name: '批次A' }));
  store.insertRecord(makeRecord({ id: 'r2' }));

  const listed = store.listBatches();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].count, 1);

  store.updateBatch(batch.id, { name: '批次B' });
  assert.equal(store.findBatchByName('批次B').name, '批次B');
  assert.equal(store.getRecord('r1').batch_name, '批次B', '重命名要同步到记录上');

  assert.equal(store.deleteBatch(batch.id), true);
  assert.equal(store.getRecord('r1').batch_id, null);
  assert.equal(store.getRecord('r1').batch_name, null);
  assert.equal(store.listBatches().length, 0);
  assert.equal(store.deleteBatch(batch.id), false);
  store.close();
});

test('统计：总数 / 今天 / 14 天序列 / 模型与标签分布', async () => {
  const store = await openStore(tmpDir());
  const now = Date.now();
  store.insertRecord(
    makeRecord({ id: 'r1', model: 'gpt', tags: ['x', 'y'], latency_ms: 100, reasoning_effort: 'high', harness: 'codex', created_at_ms: now - 1000 }),
  );
  store.insertRecord(
    makeRecord({ id: 'r2', model: 'gpt', tags: ['x'], latency_ms: 300, reasoning_effort: 'high', harness: 'codex', created_at_ms: now - 2000 }),
  );
  store.insertRecord(makeRecord({ id: 'r3', model: 'claude', status: 'error', created_at_ms: now - 40 * 86400000 }));

  const stats = store.stats();
  assert.equal(stats.backend, 'sqlite');
  assert.equal(stats.total, 3);
  assert.equal(stats.today, 2);
  assert.equal(stats.series.length, 14);
  assert.equal(stats.series[13].count, 2);

  const gpt = stats.models.find((m) => m.model === 'gpt');
  assert.equal(gpt.count, 2);
  assert.equal(gpt.avg_latency_ms, 200);
  assert.equal(stats.models.find((m) => m.model === 'claude').errors, 1);
  assert.equal(stats.tags.find((t) => t.tag === 'x').count, 2);
  assert.equal(stats.statuses.find((s) => s.status === 'error').count, 1);
  assert.equal(stats.reasoning_efforts.find((item) => item.reasoning_effort === 'high').count, 2);
  assert.equal(stats.harnesses.find((item) => item.harness === 'codex').count, 2);
  assert.ok(stats.db_bytes > 0);
  store.close();
});
