// 存储层：优先使用 Node 内置 node:sqlite（Node >= 22.5，Node 24 无需 flag），
// 若运行环境不支持则自动回退到本地 JSON 文件存储。两种后端暴露完全一致的方法。
//
// 数据落盘位置：<dataDir>/records.db（sqlite）或 <dataDir>/records.json（fallback）
// 附件落盘位置：<dataDir>/files/

import fs from 'node:fs';
import path from 'node:path';
import { newId, nowMs, toIso, safeJsonParse, escapeLike, asString, safeDecodeURI } from './util.mjs';
import { removeFileByRelativePath } from './files.mjs';

/* ------------------------------------------------------------------ *
 * 记录字段定义（两种后端共用）
 * ------------------------------------------------------------------ */

export const COLUMNS = [
  'id',
  'title',
  'prompt',
  'model',
  'provider',
  'batch_id',
  'batch_name',
  'tags',
  'status',
  'result_type',
  'result',
  'parts',
  'error',
  'latency_ms',
  'tokens_in',
  'tokens_out',
  'total_tokens',
  'cost',
  'currency',
  'meta',
  'attachments',
  'source',
  'idempotency_key',
  'created_at',
  'created_at_ms',
  'updated_at',
  'updated_at_ms',
];

const JSON_COLUMNS = new Set(['tags', 'parts', 'meta', 'attachments']);

/** 把一行数据库记录还原成 API 对象 */
function rowToRecord(row) {
  if (!row) return null;
  const out = {};
  for (const key of COLUMNS) out[key] = row[key] === undefined ? null : row[key];
  for (const key of JSON_COLUMNS) {
    const parsed = safeJsonParse(out[key], null);
    if (key === 'tags') out.tags = Array.isArray(parsed) ? parsed : [];
    else if (key === 'parts') out.parts = Array.isArray(parsed) ? parsed : [];
    else if (key === 'attachments') out.attachments = Array.isArray(parsed) ? parsed : [];
    else out.meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  out.created_at = out.created_at || toIso(out.created_at_ms || Date.now());
  out.created_at_ms = out.created_at_ms || Date.parse(out.created_at) || Date.now();
  out.created_at_local = localString(out.created_at_ms);
  return out;
}

function localString(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 序列化成可入库的值（node:sqlite 不接受 undefined / boolean） */
function bindValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function recordBindings(record) {
  return COLUMNS.map((key) => {
    const v = record[key];
    if (JSON_COLUMNS.has(key) || key === 'meta') {
      return JSON.stringify(v === undefined || v === null ? (key === 'meta' ? {} : []) : v);
    }
    return bindValue(v);
  });
}

/**
 * 附件文件垃圾回收：只删「已经没有任何记录引用」的本地文件。
 * 调用方必须先把记录的新状态写库，再来清理由此产生的孤儿文件。
 */
function collectOrphanFiles(dataDir, attachments, isReferenced) {
  let deleted = 0;
  for (const att of Array.isArray(attachments) ? attachments : []) {
    if (!att || !att.path || att.remote) continue;
    if (isReferenced(att.url)) continue;
    if (removeFileByRelativePath(dataDir, att.path)) deleted += 1;
  }
  return deleted;
}

/**
 * 找出记录里「指向本地文件的结果本身」的引用。
 * 现在的设计是：文件型结果直接存在 result（或某个 part 的 content）里，形如 /files/xxx.pdf，
 * 它同样需要参与孤儿文件回收。
 */
export function recordLocalFileRefs(record) {
  if (!record) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const text = asString(value).trim();
    if (!text.startsWith('/files/') || seen.has(text)) return;
    seen.add(text);
    out.push({ url: text, path: `files/${safeDecodeURI(text.slice('/files/'.length))}`, remote: false });
  };
  push(record.result);
  for (const part of Array.isArray(record.parts) ? record.parts : []) {
    if (!part) continue;
    if (part.type && ['text', 'markdown', 'code'].includes(part.type)) continue;
    push(part.content);
  }
  return out;
}

/** 一条记录占用到的全部本地文件引用（附件 + 文件型结果） */
export function recordLocalFiles(record) {
  return [...(Array.isArray(record && record.attachments) ? record.attachments : []), ...recordLocalFileRefs(record)];
}

/* ------------------------------------------------------------------ *
 * SQLite 后端
 * ------------------------------------------------------------------ */

class SqliteStore {
  constructor(db, dataDir) {
    this.backend = 'sqlite';
    this.db = db;
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'records.db');
  }

  static async open(dataDir) {
    const mod = await import('node:sqlite');
    const DatabaseSync = mod && (mod.DatabaseSync || (mod.default && mod.default.DatabaseSync));
    if (typeof DatabaseSync !== 'function') throw new Error('node:sqlite 不可用');
    const db = new DatabaseSync(path.join(dataDir, 'records.db'));
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS records (
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
      CREATE INDEX IF NOT EXISTS idx_records_created ON records (created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_records_model ON records (model);
      CREATE INDEX IF NOT EXISTS idx_records_batch ON records (batch_id);
      CREATE INDEX IF NOT EXISTS idx_records_type ON records (result_type);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_records_idem ON records (idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        name TEXT,
        note TEXT,
        created_at TEXT,
        created_at_ms INTEGER,
        updated_at TEXT,
        updated_at_ms INTEGER
      );
    `);
    return new SqliteStore(db, dataDir);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params.map(bindValue));
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params.map(bindValue));
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params.map(bindValue));
  }

  /* ---------------------------- 记录 ---------------------------- */

  insertRecord(record) {
    const placeholders = COLUMNS.map(() => '?').join(', ');
    this.db.exec('BEGIN');
    try {
      this.run(`INSERT INTO records (${COLUMNS.join(', ')}) VALUES (${placeholders})`, recordBindings(record));
      if (record.batch_id && record.batch_name) this.ensureBatch(record.batch_id, record.batch_name);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
    return this.getRecord(record.id);
  }

  findByIdempotencyKey(key) {
    if (!key) return null;
    const row = this.get('SELECT * FROM records WHERE idempotency_key = ? LIMIT 1', [key]);
    return rowToRecord(row);
  }

  getRecord(id) {
    const row = this.get('SELECT * FROM records WHERE id = ?', [id]);
    return rowToRecord(row);
  }

  listRecords(filter = {}) {
    const { where, params } = this.buildWhere(filter);
    const order = filter.order === 'asc' ? 'ASC' : 'DESC';
    const limit = Number.isFinite(filter.limit) ? filter.limit : 50;
    const offset = Number.isFinite(filter.offset) ? filter.offset : 0;
    const totalRow = this.get(`SELECT COUNT(*) AS c FROM records ${where}`, params);
    const rows = this.all(
      `SELECT * FROM records ${where} ORDER BY created_at_ms ${order}, id ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      total: totalRow ? Number(totalRow.c) : 0,
      items: rows.map(rowToRecord),
      limit,
      offset,
    };
  }

  buildWhere(filter) {
    const clauses = [];
    const params = [];
    if (filter.q) {
      const like = `%${escapeLike(filter.q)}%`;
      clauses.push(
        "(title LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR batch_name LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like, like, like);
    }
    if (filter.model) {
      const models = Array.isArray(filter.model) ? filter.model : [filter.model];
      if (models.length) {
        clauses.push(`model IN (${models.map(() => '?').join(', ')})`);
        params.push(...models);
      }
    }
    if (filter.tags && filter.tags.length) {
      for (const tag of filter.tags) {
        clauses.push("tags LIKE ? ESCAPE '\\'");
        params.push(`%"${escapeLike(tag)}"%`);
      }
    }
    if (filter.batch_id) {
      clauses.push('batch_id = ?');
      params.push(filter.batch_id);
    }
    // ?batch= 既可以是批次 id，也可以是批次名，两个都试
    if (filter.batch) {
      clauses.push('(batch_id = ? OR batch_name = ?)');
      params.push(filter.batch, filter.batch);
    }
    if (filter.result_type) {
      clauses.push('result_type = ?');
      params.push(filter.result_type);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (Number.isFinite(filter.from_ms)) {
      clauses.push('created_at_ms >= ?');
      params.push(filter.from_ms);
    }
    if (Number.isFinite(filter.to_ms)) {
      clauses.push('created_at_ms <= ?');
      params.push(filter.to_ms);
    }
    if (filter.ids && filter.ids.length) {
      clauses.push(`id IN (${filter.ids.map(() => '?').join(', ')})`);
      params.push(...filter.ids);
    }
    if (filter.exclude_seed) {
      clauses.push("(source IS NULL OR source <> 'seed')");
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  updateRecord(id, patch) {
    const keys = Object.keys(patch).filter((k) => COLUMNS.includes(k));
    if (!keys.length) return this.getRecord(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const params = keys.map((k) => (JSON_COLUMNS.has(k) ? JSON.stringify(patch[k] ?? (k === 'meta' ? {} : [])) : bindValue(patch[k])));
    this.run(`UPDATE records SET ${sets} WHERE id = ?`, [...params, id]);
    return this.getRecord(id);
  }

  deleteRecord(id) {
    const record = this.getRecord(id);
    if (!record) return false;
    this.run('DELETE FROM records WHERE id = ?', [id]);
    // 行已经删掉，此时再做引用计数就是「其他记录是否还在用这个文件」
    collectOrphanFiles(this.dataDir, recordLocalFiles(record), (url) => this.attachmentRefCount(url) > 0);
    return true;
  }

  /** 有多少条记录引用了这个本地文件（附件、文件型结果、分段里的文件都算） */
  attachmentRefCount(url) {
    if (!url) return 0;
    const like = `%${escapeLike(url)}%`;
    const row = this.get(
      "SELECT COUNT(*) AS c FROM records WHERE attachments LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\' OR parts LIKE ? ESCAPE '\\'",
      [like, like, like],
    );
    return row ? Number(row.c) : 0;
  }

  /** 删除这批引用里已经没人用的本地文件，返回删除数量 */
  purgeAttachmentFiles(attachments) {
    return collectOrphanFiles(this.dataDir, attachments, (url) => this.attachmentRefCount(url) > 0);
  }

  deleteRecords(ids) {
    let removed = 0;
    for (const id of ids) {
      if (this.deleteRecord(id)) removed += 1;
    }
    return removed;
  }

  /* ---------------------------- 批次 ---------------------------- */

  ensureBatch(id, name) {
    const existing = this.get('SELECT id FROM batches WHERE id = ?', [id]);
    if (existing) return;
    const ms = nowMs();
    this.run('INSERT INTO batches (id, name, note, created_at, created_at_ms, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      name,
      '',
      toIso(ms),
      ms,
      toIso(ms),
      ms,
    ]);
  }

  listBatches() {
    const counts = new Map();
    for (const row of this.all('SELECT batch_id AS id, COUNT(*) AS c FROM records WHERE batch_id IS NOT NULL GROUP BY batch_id')) {
      counts.set(row.id, Number(row.c));
    }
    return this.all('SELECT * FROM batches ORDER BY created_at_ms DESC').map((row) => ({
      ...row,
      count: counts.get(row.id) || 0,
    }));
  }

  createBatch({ id, name, note }) {
    const batchId = id || newId('bat');
    const ms = nowMs();
    this.run('INSERT INTO batches (id, name, note, created_at, created_at_ms, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      batchId,
      name || '未命名批次',
      note || '',
      toIso(ms),
      ms,
      toIso(ms),
      ms,
    ]);
    return this.get('SELECT * FROM batches WHERE id = ?', [batchId]);
  }

  findBatchByName(name) {
    if (!name) return null;
    return this.get('SELECT * FROM batches WHERE name = ? LIMIT 1', [name]) || null;
  }

  updateBatch(id, patch) {
    const keys = Object.keys(patch).filter((k) => ['name', 'note'].includes(k));
    if (!keys.length) return this.get('SELECT * FROM batches WHERE id = ?', [id]) || null;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    this.run(`UPDATE batches SET ${sets}, updated_at = ?, updated_at_ms = ? WHERE id = ?`, [
      ...keys.map((k) => bindValue(patch[k])),
      toIso(nowMs()),
      nowMs(),
      id,
    ]);
    if (patch.name) this.run('UPDATE records SET batch_name = ? WHERE batch_id = ?', [patch.name, id]);
    return this.get('SELECT * FROM batches WHERE id = ?', [id]) || null;
  }

  deleteBatch(id) {
    this.run('UPDATE records SET batch_id = NULL, batch_name = NULL WHERE batch_id = ?', [id]);
    const res = this.run('DELETE FROM batches WHERE id = ?', [id]);
    return Number(res && res.changes ? res.changes : 0) > 0;
  }

  /* ---------------------------- 统计 ---------------------------- */

  stats() {
    const total = Number((this.get('SELECT COUNT(*) AS c FROM records') || {}).c || 0);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayStart = dayStart.getTime();
    const since14 = todayStart - 13 * 86400000;

    const recent = this.all(
      'SELECT created_at_ms, model, status, result_type, latency_ms, tags FROM records WHERE created_at_ms >= ? ORDER BY created_at_ms ASC',
      [since14],
    );
    const series = buildSeries(recent, 14);
    const tags = buildTagCounts(this.all('SELECT tags FROM records ORDER BY created_at_ms DESC LIMIT 20000').map((r) => r.tags));

    const modelRows = this.all(
      "SELECT model, COUNT(*) AS count, AVG(latency_ms) AS avg_latency, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors FROM records GROUP BY model ORDER BY count DESC LIMIT 50",
    );
    const typeRows = this.all('SELECT result_type AS type, COUNT(*) AS count FROM records GROUP BY result_type ORDER BY count DESC');
    const statusRows = this.all('SELECT status, COUNT(*) AS count FROM records GROUP BY status ORDER BY count DESC');

    const today = Number((this.get('SELECT COUNT(*) AS c FROM records WHERE created_at_ms >= ?', [todayStart]) || {}).c || 0);
    const last7 = Number((this.get('SELECT COUNT(*) AS c FROM records WHERE created_at_ms >= ?', [todayStart - 6 * 86400000]) || {}).c || 0);
    const last30 = Number((this.get('SELECT COUNT(*) AS c FROM records WHERE created_at_ms >= ?', [todayStart - 29 * 86400000]) || {}).c || 0);

    return finishStats({
      backend: this.backend,
      total,
      today,
      last7,
      last30,
      series,
      tags,
      models: modelRows.map((r) => ({
        model: r.model || '(未填模型)',
        count: Number(r.count),
        avg_latency_ms: r.avg_latency === null || r.avg_latency === undefined ? null : Math.round(Number(r.avg_latency)),
        errors: Number(r.errors || 0),
      })),
      types: typeRows.map((r) => ({ type: r.type || 'text', count: Number(r.count) })),
      statuses: statusRows.map((r) => ({ status: r.status || 'ok', count: Number(r.count) })),
      dbBytes: this.fileSize(),
      fileBytes: dirSize(path.join(this.dataDir, 'files')),
    });
  }

  fileSize() {
    try {
      return fs.statSync(this.dbFile).size;
    } catch {
      return 0;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  vacuum() {
    try {
      this.db.exec('VACUUM;');
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSON 文件后端（Node 版本过低时的回退方案）
 * ------------------------------------------------------------------ */

class JsonStore {
  constructor(dataDir) {
    this.backend = 'json';
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'records.json');
    this.state = { records: [], batches: [] };
    this.timer = null;
    this.load();
  }

  static async open(dataDir) {
    return new JsonStore(dataDir);
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const parsed = safeJsonParse(fs.readFileSync(this.file, 'utf8'), null);
    if (parsed && Array.isArray(parsed.records)) this.state.records = parsed.records;
    if (parsed && Array.isArray(parsed.batches)) this.state.batches = parsed.batches;
  }

  schedulePersist() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persistNow();
    }, 120);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  persistNow() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {
      /* ignore */
    }
  }

  insertRecord(record) {
    this.state.records.push(record);
    if (record.batch_id && record.batch_name && !this.state.batches.some((b) => b.id === record.batch_id)) {
      const ms = nowMs();
      this.state.batches.push({
        id: record.batch_id,
        name: record.batch_name,
        note: '',
        created_at: toIso(ms),
        created_at_ms: ms,
        updated_at: toIso(ms),
        updated_at_ms: ms,
      });
    }
    this.schedulePersist();
    return record;
  }

  findByIdempotencyKey(key) {
    if (!key) return null;
    return this.state.records.find((r) => r.idempotency_key === key) || null;
  }

  getRecord(id) {
    return this.state.records.find((r) => r.id === id) || null;
  }

  listRecords(filter = {}) {
    const all = this.state.records.filter((r) => matchesFilter(r, filter));
    all.sort((a, b) => (filter.order === 'asc' ? a.created_at_ms - b.created_at_ms : b.created_at_ms - a.created_at_ms));
    const limit = Number.isFinite(filter.limit) ? filter.limit : 50;
    const offset = Number.isFinite(filter.offset) ? filter.offset : 0;
    return { total: all.length, items: all.slice(offset, offset + limit), limit, offset };
  }

  updateRecord(id, patch) {
    const record = this.getRecord(id);
    if (!record) return null;
    for (const key of Object.keys(patch)) {
      if (COLUMNS.includes(key)) record[key] = patch[key];
    }
    this.schedulePersist();
    return record;
  }

  deleteRecord(id) {
    const index = this.state.records.findIndex((r) => r.id === id);
    if (index < 0) return false;
    const [record] = this.state.records.splice(index, 1);
    this.schedulePersist();
    collectOrphanFiles(this.dataDir, recordLocalFiles(record), (url) => this.attachmentRefCount(url) > 0);
    return true;
  }

  /** 有多少条记录引用了这个本地文件（附件、文件型结果、分段里的文件都算） */
  attachmentRefCount(url) {
    if (!url) return 0;
    return this.state.records.filter((r) => {
      if ((r.attachments || []).some((a) => a && a.url === url)) return true;
      if (typeof r.result === 'string' && r.result.includes(url)) return true;
      if (Array.isArray(r.parts) && r.parts.some((p) => p && typeof p.content === 'string' && p.content.includes(url))) return true;
      return false;
    }).length;
  }

  /** 删除这批引用里已经没人用的本地文件，返回删除数量 */
  purgeAttachmentFiles(attachments) {
    return collectOrphanFiles(this.dataDir, attachments, (url) => this.attachmentRefCount(url) > 0);
  }

  deleteRecords(ids) {
    let removed = 0;
    for (const id of ids) if (this.deleteRecord(id)) removed += 1;
    return removed;
  }

  listBatches() {
    return this.state.batches
      .map((b) => ({ ...b, count: this.state.records.filter((r) => r.batch_id === b.id).length }))
      .sort((a, b) => (b.created_at_ms || 0) - (a.created_at_ms || 0));
  }

  createBatch({ id, name, note }) {
    const ms = nowMs();
    const batch = {
      id: id || newId('bat'),
      name: name || '未命名批次',
      note: note || '',
      created_at: toIso(ms),
      created_at_ms: ms,
      updated_at: toIso(ms),
      updated_at_ms: ms,
    };
    this.state.batches.push(batch);
    this.schedulePersist();
    return batch;
  }

  findBatchByName(name) {
    if (!name) return null;
    return this.state.batches.find((b) => b.name === name) || null;
  }

  updateBatch(id, patch) {
    const batch = this.state.batches.find((b) => b.id === id);
    if (!batch) return null;
    if (patch.name !== undefined) batch.name = patch.name;
    if (patch.note !== undefined) batch.note = patch.note;
    batch.updated_at_ms = nowMs();
    batch.updated_at = toIso(batch.updated_at_ms);
    if (patch.name) {
      for (const r of this.state.records) if (r.batch_id === id) r.batch_name = patch.name;
    }
    this.schedulePersist();
    return batch;
  }

  deleteBatch(id) {
    const before = this.state.batches.length;
    this.state.batches = this.state.batches.filter((b) => b.id !== id);
    for (const r of this.state.records) {
      if (r.batch_id === id) {
        r.batch_id = null;
        r.batch_name = null;
      }
    }
    this.schedulePersist();
    return this.state.batches.length < before;
  }

  stats() {
    const records = this.state.records;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayStart = dayStart.getTime();
    const since14 = todayStart - 13 * 86400000;
    const recent = records.filter((r) => r.created_at_ms >= since14).sort((a, b) => a.created_at_ms - b.created_at_ms);

    const modelMap = new Map();
    for (const r of records) {
      const key = r.model || '(未填模型)';
      const item = modelMap.get(key) || { model: key, count: 0, errors: 0, latencySum: 0, latencyCount: 0 };
      item.count += 1;
      if (r.status === 'error') item.errors += 1;
      if (Number.isFinite(r.latency_ms)) {
        item.latencySum += Number(r.latency_ms);
        item.latencyCount += 1;
      }
      modelMap.set(key, item);
    }
    const typeMap = new Map();
    const statusMap = new Map();
    for (const r of records) {
      typeMap.set(r.result_type || 'text', (typeMap.get(r.result_type || 'text') || 0) + 1);
      statusMap.set(r.status || 'ok', (statusMap.get(r.status || 'ok') || 0) + 1);
    }

    return finishStats({
      backend: this.backend,
      total: records.length,
      today: records.filter((r) => r.created_at_ms >= todayStart).length,
      last7: records.filter((r) => r.created_at_ms >= todayStart - 6 * 86400000).length,
      last30: records.filter((r) => r.created_at_ms >= todayStart - 29 * 86400000).length,
      series: buildSeries(recent, 14),
      tags: buildTagCounts(records.map((r) => r.tags)),
      models: [...modelMap.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 50)
        .map((m) => ({
          model: m.model,
          count: m.count,
          errors: m.errors,
          avg_latency_ms: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : null,
        })),
      types: [...typeMap.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
      statuses: [...statusMap.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
      dbBytes: (() => {
        try {
          return fs.statSync(this.file).size;
        } catch {
          return 0;
        }
      })(),
      fileBytes: dirSize(path.join(this.dataDir, 'files')),
    });
  }

  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.persistNow();
  }

  vacuum() {
    this.persistNow();
  }
}

/* ------------------------------------------------------------------ *
 * 共用辅助
 * ------------------------------------------------------------------ */

function matchesFilter(r, f) {
  if (f.q) {
    const needle = String(f.q).toLowerCase();
    const haystack = [r.title, r.prompt, r.result, r.model, r.batch_name, (r.tags || []).join(' ')].join('\n').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (f.model) {
    const models = Array.isArray(f.model) ? f.model : [f.model];
    if (models.length && !models.includes(r.model)) return false;
  }
  if (f.tags && f.tags.length) {
    const own = r.tags || [];
    if (!f.tags.every((t) => own.includes(t))) return false;
  }
  if (f.batch_id && r.batch_id !== f.batch_id) return false;
  if (f.batch && r.batch_id !== f.batch && r.batch_name !== f.batch) return false;
  if (f.result_type && r.result_type !== f.result_type) return false;
  if (f.status && r.status !== f.status) return false;
  if (f.source && r.source !== f.source) return false;
  if (Number.isFinite(f.from_ms) && r.created_at_ms < f.from_ms) return false;
  if (Number.isFinite(f.to_ms) && r.created_at_ms > f.to_ms) return false;
  if (f.ids && f.ids.length && !f.ids.includes(r.id)) return false;
  if (f.exclude_seed && r.source === 'seed') return false;
  return true;
}

function buildSeries(recent, days) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const buckets = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const start = dayStart.getTime() - i * 86400000;
    const d = new Date(start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const bucket = { date: key, count: 0, errors: 0 };
    buckets.push(bucket);
    index.set(key, bucket);
  }
  for (const r of recent) {
    const d = new Date(r.created_at_ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const bucket = index.get(key);
    if (!bucket) continue;
    bucket.count += 1;
    if (r.status === 'error') bucket.errors += 1;
  }
  return buckets;
}

function buildTagCounts(jsonList) {
  const map = new Map();
  for (const item of jsonList) {
    const tags = Array.isArray(item) ? item : safeJsonParse(item, []);
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      const key = asString(tag).trim();
      if (!key) continue;
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return [...map.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count).slice(0, 100);
}

function finishStats(base) {
  const maxSeries = base.series.reduce((m, d) => Math.max(m, d.count), 0);
  return {
    ...base,
    series_max: maxSeries,
    db_bytes: base.dbBytes,
    file_bytes: base.fileBytes,
    generated_at: new Date().toISOString(),
  };
}

function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * 打开存储
 * ------------------------------------------------------------------ */

export async function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });
  try {
    return await SqliteStore.open(dataDir);
  } catch (err) {
    const store = await JsonStore.open(dataDir);
    store.fallbackReason = err && err.message ? err.message : String(err);
    return store;
  }
}

export { rowToRecord };
