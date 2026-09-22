#!/usr/bin/env node
// 模型测试记录台 · 零依赖服务端
//
//   node server.mjs                 # 默认 127.0.0.1:8788
//   node server.mjs --port 9000     # 指定端口
//   node server.mjs --host 0.0.0.0  # 允许局域网访问
//   node server.mjs --no-seed       # 不写入示例数据
//
// 数据目录：<项目>/data/（records.db + files/）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { openStore, recordLocalFileRefs, recordLocalFiles } from './lib/store.mjs';
import { normalizeRecordPayload, normalizeBatchPayload, buildSeedRecords } from './lib/payload.mjs';
import { saveFile, guessMime, resolveDataFile } from './lib/files.mjs';
import { newId, nowMs, toIso, clampInt, asString, csvCell, formatLocal, localOffset, parseTimeToMs } from './lib/util.mjs';

/* ------------------------------------------------------------------ *
 * 启动参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2);

function flagValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
}

const hasFlag = (name) => argv.includes(`--${name}`);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(flagValue('data-dir', process.env.DATA_DIR || path.join(ROOT, 'data')));
const HOST = flagValue('host', process.env.HOST || '127.0.0.1');
const PORT = clampInt(flagValue('port', process.env.PORT || 8788), 0, 65535, 8788);
const MAX_BODY = clampInt(flagValue('max-body-mb', process.env.MAX_BODY_MB || 32), 1, 512, 32) * 1024 * 1024;
const SEED = !hasFlag('no-seed') && process.env.SEED !== '0';
const QUIET = hasFlag('quiet');

const VERSION = '1.1.0';
const STARTED_AT = nowMs();

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** multipart 里这些字段名表示「这个文件就是结果」，而不是附件 */
const RESULT_FILE_FIELDS = new Set(['result', 'output', 'content', 'file', 'media', 'result_file', 'resultfile']);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Filename, X-File-Name',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Expose-Headers': 'Content-Disposition, X-Total-Count',
};

function sendJson(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, text, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'Content-Length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res, buffer, contentType, extraHeaders = {}) {
  res.writeHead(200, {
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    ...extraHeaders,
  });
  res.end(buffer);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // 已经超限：继续把剩余数据读完再回 413，避免连接被硬断
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `请求体超过上限 ${Math.round(limit / 1024 / 1024)}MB，可用 --max-body-mb 调整`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

function formToObject(params) {
  const out = {};
  for (const [rawKey, value] of params.entries()) {
    const isArray = rawKey.endsWith('[]');
    const key = isArray ? rawKey.slice(0, -2) : rawKey;
    const parsed = parseFormValue(value);
    if (key.startsWith('meta.')) {
      const metaKey = key.slice(5);
      if (!out.meta || typeof out.meta !== 'object') out.meta = {};
      out.meta[metaKey] = parsed;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (Array.isArray(out[key])) out[key].push(parsed);
      else out[key] = [out[key], parsed];
    } else {
      out[key] = isArray ? [parsed] : parsed;
    }
  }
  return out;
}

function parseFormValue(value) {
  const s = String(value);
  const trimmed = s.trim();
  if (!trimmed) return s;
  if (/^[[{]/.test(trimmed) || /^(true|false|null)$/.test(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return s;
    }
  }
  return s;
}

function parseMultipartBody(buffer, contentType) {
  const match = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!match) throw new HttpError(400, 'multipart/form-data 缺少 boundary');
  const boundary = `--${match[1]}`;
  const delimiter = Buffer.from(boundary);
  const fields = {};
  const files = [];

  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) throw new HttpError(400, 'multipart 内容为空');
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) break; // '--' 结束
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) cursor += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) break;
    const headerText = buffer.slice(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    let next = buffer.indexOf(delimiter, bodyStart);
    if (next < 0) next = buffer.length;
    let bodyEnd = next;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const data = buffer.slice(bodyStart, bodyEnd);

    const disposition = /content-disposition:[^\n]*/i.exec(headerText);
    const nameMatch = disposition ? /name="([^"]*)"/i.exec(disposition[0]) : null;
    const fileMatch = disposition ? /filename="([^"]*)"/i.exec(disposition[0]) : null;
    const typeMatch = /content-type:\s*([^\s;]+)/i.exec(headerText);
    const fieldName = nameMatch ? nameMatch[1] : `field_${files.length + Object.keys(fields).length}`;

    if (fileMatch && fileMatch[1]) {
      const mime = typeMatch ? typeMatch[1] : guessMime(fileMatch[1]);
      const isTextLike = /^text\//i.test(mime) || /json|xml|javascript|markdown/i.test(mime);
      const fileName = fileMatch[1];
      // 字段名叫 result / file / output… 时，这个文件「就是结果本身」，不要当成附件
      if (RESULT_FILE_FIELDS.has(fieldName.toLowerCase())) {
        if (isTextLike) {
          fields[fieldName] = data.toString('utf8');
        } else {
          const saved = saveFile(DATA_DIR, { name: fileName, mime, buffer: data });
          fields.result = saved.url;
          if (!fields.result_type) fields.result_type = saved.kind === 'image' ? 'image' : 'file';
        }
        cursor = next + delimiter.length;
        continue;
      }
      if (isTextLike) {
        const text = data.toString('utf8');
        if (Object.prototype.hasOwnProperty.call(fields, fieldName)) {
          fields[fieldName] = Array.isArray(fields[fieldName]) ? [...fields[fieldName], text] : [fields[fieldName], text];
        } else {
          fields[fieldName] = text;
        }
      } else {
        files.push({ field: fieldName, name: fileName, mime, buffer: data });
      }
    } else {
      const value = parseFormValue(data.toString('utf8'));
      if (Object.prototype.hasOwnProperty.call(fields, fieldName)) {
        fields[fieldName] = Array.isArray(fields[fieldName]) ? [...fields[fieldName], value] : [fields[fieldName], value];
      } else {
        fields[fieldName] = value;
      }
    }
    cursor = next + delimiter.length;
  }

  return { __multipartFiles: files, ...fields };
}

function parseBodyBuffer(buffer, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (!buffer.length) return {};
  if (ct.includes('application/json') || ct.includes('+json')) {
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch (err) {
      throw new HttpError(400, `JSON 解析失败：${err.message}`);
    }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return formToObject(new URLSearchParams(buffer.toString('utf8')));
  }
  if (ct.includes('multipart/form-data')) {
    return parseMultipartBody(buffer, contentType);
  }
  const text = buffer.toString('utf8');
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* 当作纯文本 */
    }
  }
  return { result: text };
}

/** 把 multipart 里上传的文件落盘，转成附件描述 */
function persistMultipartFiles(files) {
  const attachments = [];
  for (const file of files || []) {
    try {
      attachments.push(saveFile(DATA_DIR, { name: file.name, mime: file.mime, buffer: file.buffer }));
    } catch {
      /* 单个文件失败不影响登记 */
    }
  }
  return attachments;
}

/** 合并 query 与 body：body 优先；query 里剩下的字段补充进来 */
function mergeQueryAndBody(query, body) {
  if (Array.isArray(body)) return body;
  const out = { ...(body && typeof body === 'object' ? body : {}) };
  for (const [key, value] of query.entries()) {
    if (['q', 'limit', 'offset', 'order', 'download', 'format', 'pretty'].includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = parseFormValue(value);
    }
  }
  return out;
}

function splitCsv(value) {
  return asString(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseRangeBoundary(value, kind) {
  if (value === null || value === undefined || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d{10,16}$/.test(text)) return parseTimeToMs(text, undefined);
  const ms = parseTimeToMs(text, NaN);
  if (!Number.isFinite(ms)) return undefined;
  if (kind === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(text)) return ms + 86399999;
  return ms;
}

function parseListQuery(sp) {
  const limit = clampInt(sp.get('limit'), 1, 500, 50);
  const offset = clampInt(sp.get('offset'), 0, 10_000_000, 0);
  const order = sp.get('order') === 'asc' ? 'asc' : 'desc';
  const models = [...sp.getAll('model'), ...sp.getAll('models')].flatMap(splitCsv);
  const tags = [...sp.getAll('tag'), ...sp.getAll('tags')].flatMap(splitCsv);
  const reasoningEfforts = sp.getAll('reasoning_effort').flatMap(splitCsv);
  const harnesses = sp.getAll('harness').flatMap(splitCsv);
  return {
    q: asString(sp.get('q') || sp.get('search') || '').trim(),
    model: models,
    tags,
    batch_id: asString(sp.get('batch_id') || '').trim(),
    batch: asString(sp.get('batch') || '').trim(),
    result_type: asString(sp.get('type') || sp.get('result_type') || '').trim(),
    status: asString(sp.get('status') || '').trim(),
    reasoning_effort: reasoningEfforts,
    harness: harnesses,
    source: asString(sp.get('source') || '').trim(),
    from_ms: parseRangeBoundary(sp.get('from') || sp.get('since') || sp.get('start'), 'from'),
    to_ms: parseRangeBoundary(sp.get('to') || sp.get('until') || sp.get('end'), 'to'),
    ids: [...sp.getAll('id'), ...sp.getAll('ids')].flatMap(splitCsv),
    exclude_seed: sp.get('exclude_seed') === '1',
    limit,
    offset,
    order,
  };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

const ROUTES = [];
const route = (method, pattern, handler) => ROUTES.push({ method, segs: pattern.split('/').filter(Boolean), handler, pattern });

function matchRoute(method, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  let headMismatch = false;
  for (const entry of ROUTES) {
    if (entry.method !== method) continue;
    if (entry.segs.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i += 1) {
      const part = entry.segs[i];
      if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segs[i]);
      else if (part !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { entry, params };
    headMismatch = headMismatch || entry.segs[0] === segs[0];
  }
  return headMismatch ? { entry: null, params: {} } : null;
}

/* ------------------------------- 健康检查 ------------------------------- */

route('GET', '/health', async (ctx) => {
  sendJson(ctx.res, {
    ok: true,
    service: 'model-test-logbook',
    version: VERSION,
    backend: ctx.store.backend,
    uptime_seconds: Math.round((nowMs() - STARTED_AT) / 1000),
    server_time: toIso(nowMs()),
    server_time_local: formatLocal(nowMs()),
    timezone_offset: localOffset(),
    total_records: ctx.store.stats().total,
  });
});

/* ------------------------------- 接口自述 ------------------------------- */

route('GET', '/api/help', async (ctx) => {
  sendJson(ctx.res, {
    ok: true,
    service: '模型测试记录台 · 自动登记接口',
    base_url: ctx.baseUrl,
    auth: 'none',
    quick_start: [
      `curl -X POST ${ctx.baseUrl}/api/records -H 'Content-Type: application/json' -d '{"model":"gpt-5.1","reasoning_effort":"high","harness":"codex","prompt":"你好","result":"你好！","latency_ms":820}'`,
      `curl -X POST ${ctx.baseUrl}/api/records -H 'Content-Type: application/json' -d '{"model":"gpt-5.1","prompt":"做个卡片","html":"<div>hi</div>","result_type":"html"}'`,
      `curl -X POST "${ctx.baseUrl}/api/records?model=gpt-5.1&prompt=解释RAG" -H 'Content-Type: text/plain' --data-binary @result.html`,
    ],
    endpoints: [
      { method: 'POST', path: '/api/records', desc: '登记一条记录（也支持数组批量，最多 200 条）' },
      { method: 'GET', path: '/api/records', desc: '列表：q/model/tag/batch/type/status/reasoning_effort/harness/from/to/limit/offset/order' },
      { method: 'GET', path: '/api/records/:id', desc: '单条详情' },
      { method: 'PATCH', path: '/api/records/:id', desc: '更新标题/标签/批次/meta 等' },
      { method: 'DELETE', path: '/api/records/:id', desc: '删除一条' },
      { method: 'POST', path: '/api/records/bulk-delete', desc: '批量删除 {"ids":[...]}' },
      { method: 'POST', path: '/api/records/:id/attachments', desc: '追加附件（支持 base64 / data URL / 远程 URL）' },
      { method: 'GET', path: '/api/facets', desc: '筛选面板数据（模型 / 标签 / 类型 / 状态 / 批次计数）' },
      { method: 'GET', path: '/api/stats', desc: '统计概览' },
      { method: 'GET', path: '/api/batches', desc: '批次列表' },
      { method: 'POST', path: '/api/batches', desc: '新建批次 {"name":"...","note":"..."}' },
      { method: 'GET', path: '/api/export?format=json|ndjson|csv', desc: '导出全部（支持与列表相同的筛选参数）' },
      { method: 'POST', path: '/api/files', desc: '单独上传文件（原始二进制或 JSON base64）' },
      { method: 'GET', path: '/r/:id', desc: '把某条记录的结果当网页打开（HTML 直接渲染）' },
    ],
    field_aliases: FIELD_ALIASES_DOC,
    notes: [
      '未识别的字段不会丢失，会原样保存在 meta._extra 里',
      'reasoning_effort 和 harness 只使用标准字段名，不提供别名兼容',
      'result_type 不传会自动推断（html / json / markdown / text / image）',
      'created_at 支持 ISO 字符串、秒级/毫秒级时间戳；不传则用服务器当前时间',
      '带 idempotency_key（或 request_id / trace_id）重复提交时不会新增，只返回已有记录',
      '结果里的 HTML 在界面上以沙箱 iframe 渲染，不会影响主页面',
    ],
  });
});

const FIELD_ALIASES_DOC = {
  prompt: ['prompt', 'prompt_text', 'input', 'user_prompt', 'question', 'query', 'messages'],
  model: ['model', 'model_name', 'model_id', 'engine'],
  reasoning_effort: ['reasoning_effort'],
  harness: ['harness'],
  result: ['result', 'output', 'response', 'content', 'answer', 'completion', 'text', 'html'],
  parts: ['parts', 'results', 'outputs', 'items', 'blocks'],
  result_type: ['result_type', 'resultType', 'format', 'output_type', 'content_type', 'type'],
  title: ['title', 'name', 'label', 'subject'],
  tags: ['tags', 'tag', 'labels', 'keywords'],
  batch: ['batch', 'batch_name', 'group', 'session', 'run_id', 'test_id'],
  status: ['status', 'state', 'ok', 'success'],
  error: ['error', 'error_message', 'err', 'failure', 'exception'],
  latency_ms: ['latency_ms', 'latency', 'duration', 'duration_ms', 'elapsed_ms'],
  tokens_in: ['tokens_in', 'prompt_tokens', 'input_tokens'],
  tokens_out: ['tokens_out', 'completion_tokens', 'output_tokens'],
  cost: ['cost', 'price', 'usd', 'fee'],
  created_at: ['created_at', 'createdAt', 'time', 'timestamp', 'ts', 'date'],
  idempotency_key: ['idempotency_key', 'request_id', 'trace_id', 'dedupe_key'],
  attachments: ['attachments', 'files', 'images', 'image', 'image_url', 'screenshot'],
  meta: ['meta', 'metadata', 'extra', 'details'],
};

/* ------------------------------- 记录 CRUD ------------------------------- */

route('POST', '/api/records', async (ctx) => {
  const body = ctx.body;
  let items = null;
  if (Array.isArray(body)) items = body;
  else if (body && typeof body === 'object' && Array.isArray(body.records)) items = body.records;
  else if (body && typeof body === 'object' && Array.isArray(body.items)) items = body.items;

  const multipartFiles = body && typeof body === 'object' ? body.__multipartFiles : null;
  const extraAttachments = multipartFiles ? persistMultipartFiles(multipartFiles) : [];

  if (items) {
    if (items.length > 200) throw new HttpError(400, '批量登记一次最多 200 条');
    const ids = [];
    const duplicates = [];
    const warnings = [];
    for (const item of items) {
      const { record, warnings: warns } = normalizeRecordPayload(preparePayload(item, extraAttachments, ctx), {
        dataDir: DATA_DIR,
        source: 'api',
      });
      const result = insertOne(ctx.store, record);
      if (result.duplicate) duplicates.push(result.record.id);
      else ids.push(result.record.id);
      if (warns.length) warnings.push({ id: result.record.id, warnings: warns });
    }
    sendJson(ctx.res, { ok: true, created: ids.length, duplicates: duplicates.length, ids, duplicate_ids: duplicates, warnings }, 201);
    return;
  }

  const prepared = preparePayload(mergeQueryAndBody(ctx.url.searchParams, body), extraAttachments, ctx);
  const { record, warnings } = normalizeRecordPayload(prepared, { dataDir: DATA_DIR, source: 'api' });
  const result = insertOne(ctx.store, record);
  sendJson(
    ctx.res,
    {
      ok: true,
      duplicate: !!result.duplicate,
      id: result.record.id,
      created_at: result.record.created_at,
      created_at_local: result.record.created_at_local,
      title: result.record.title,
      model: result.record.model,
      reasoning_effort: result.record.reasoning_effort,
      harness: result.record.harness,
      result_type: result.record.result_type,
      url: `${ctx.baseUrl}/r/${result.record.id}`,
      warnings,
    },
    result.duplicate ? 200 : 201,
  );
});

function preparePayload(payload, extraAttachments, ctx) {
  const out = Array.isArray(payload) ? payload : { ...(payload || {}) };
  if (Array.isArray(out)) return out;
  if (extraAttachments && extraAttachments.length) {
    const existing = out.attachments;
    out.attachments = existing ? [...(Array.isArray(existing) ? existing : [existing]), ...extraAttachments] : extraAttachments;
  }
  if (out.__multipartFiles) delete out.__multipartFiles;
  if (!out.idempotency_key && ctx.req.headers['x-idempotency-key']) out.idempotency_key = ctx.req.headers['x-idempotency-key'];
  return out;
}

function insertOne(store, record) {
  if (record.idempotency_key) {
    const existing = store.findByIdempotencyKey(record.idempotency_key);
    if (existing) return { duplicate: true, record: existing };
  }
  const warnings = [];
  if (record.batch_name && !record.batch_id) {
    const batch = store.findBatchByName(record.batch_name);
    if (batch) record.batch_id = batch.id;
    else {
      const created = store.createBatch({ name: record.batch_name, note: '' });
      record.batch_id = created.id;
    }
  } else if (record.batch_id && !record.batch_name) {
    const existingBatch = store.listBatches().find((b) => b.id === record.batch_id);
    record.batch_name = existingBatch ? existingBatch.name : '';
  }
  store.insertRecord(record);
  const saved = store.getRecord(record.id) || record;
  if (!saved.created_at_local) saved.created_at_local = formatLocal(saved.created_at_ms);
  return { duplicate: false, record: saved, warnings };
}

route('GET', '/api/records', async (ctx) => {
  const filter = parseListQuery(ctx.url.searchParams);
  const page = ctx.store.listRecords(filter);
  sendJson(ctx.res, { ok: true, ...page, count: page.items.length, backend: ctx.store.backend }, 200, {
    'X-Total-Count': String(page.total),
  });
});

route('GET', '/api/records/:id', async (ctx) => {
  const record = ctx.store.getRecord(ctx.params.id);
  if (!record) throw new HttpError(404, `记录不存在：${ctx.params.id}`);
  sendJson(ctx.res, { ok: true, record });
});

route('PATCH', '/api/records/:id', async (ctx) => {
  const id = ctx.params.id;
  const existing = ctx.store.getRecord(id);
  if (!existing) throw new HttpError(404, `记录不存在：${id}`);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const patch = {};

  if (body.title !== undefined) patch.title = asString(body.title);
  if (body.tags !== undefined) patch.tags = Array.isArray(body.tags) ? body.tags.map(asString) : splitCsv(body.tags);
  if (body.model !== undefined || body.model_name !== undefined) patch.model = asString(body.model ?? body.model_name);
  if (body.provider !== undefined) patch.provider = asString(body.provider);
  if (body.reasoning_effort !== undefined) patch.reasoning_effort = asString(body.reasoning_effort).trim();
  if (body.harness !== undefined) patch.harness = asString(body.harness).trim();
  if (body.status !== undefined) patch.status = asString(body.status);
  if (body.result_type !== undefined || body.type !== undefined) patch.result_type = asString(body.result_type ?? body.type);
  if (body.prompt !== undefined) patch.prompt = asString(body.prompt);
  if (body.result !== undefined || body.output !== undefined) patch.result = asString(body.result ?? body.output);
  if (body.error !== undefined) patch.error = asString(body.error);
  if (body.latency_ms !== undefined) patch.latency_ms = body.latency_ms === null ? null : Number(body.latency_ms);
  if (body.cost !== undefined) patch.cost = body.cost === null ? null : Number(body.cost);
  if (body.currency !== undefined) patch.currency = asString(body.currency);
  if (body.created_at !== undefined) {
    const ms = parseTimeToMs(body.created_at, NaN);
    if (Number.isFinite(ms)) {
      patch.created_at = toIso(ms);
      patch.created_at_ms = ms;
    }
  }
  if (body.meta !== undefined || body.note !== undefined) {
    const meta = { ...(existing.meta || {}) };
    if (body.meta && typeof body.meta === 'object') Object.assign(meta, body.meta);
    if (body.note !== undefined) meta.note = asString(body.note);
    patch.meta = meta;
  }
  if (body.batch !== undefined || body.batch_name !== undefined || body.batch_id !== undefined) {
    const name = asString(body.batch ?? body.batch_name).trim();
    const batchId = asString(body.batch_id).trim();
    if (batchId) {
      const found = ctx.store.listBatches().find((b) => b.id === batchId);
      patch.batch_id = batchId;
      patch.batch_name = found ? found.name : name;
    } else if (name) {
      const found = ctx.store.findBatchByName(name);
      const batch = found || ctx.store.createBatch({ name, note: '' });
      patch.batch_id = batch.id;
      patch.batch_name = batch.name;
    } else {
      patch.batch_id = null;
      patch.batch_name = '';
    }
  }
  if (body.attachments !== undefined || body.add_attachments !== undefined) {
    const base =
      body.attachments !== undefined
        ? normalizeRecordPayload({ attachments: body.attachments }, { dataDir: DATA_DIR }).record.attachments
        : existing.attachments || [];
    const added =
      body.add_attachments !== undefined
        ? normalizeRecordPayload({ attachments: body.add_attachments }, { dataDir: DATA_DIR }).record.attachments
        : [];
    patch.attachments = [...base, ...added];
  }

  patch.updated_at = toIso(nowMs());
  patch.updated_at_ms = nowMs();

  // 先算出这次被摘掉的本地文件（附件 + 文件型结果），写库之后再清理没人引用的
  const before = recordLocalFiles(existing);
  const after = recordLocalFiles({ ...existing, ...patch });
  const removedAttachments = before.filter((att) => att && !after.some((next) => next && next.url === att.url));

  const updated = ctx.store.updateRecord(id, patch);
  const removedFiles = ctx.store.purgeAttachmentFiles(removedAttachments);
  sendJson(ctx.res, { ok: true, record: updated, removed_files: removedFiles });
});

route('DELETE', '/api/records/:id', async (ctx) => {
  const removed = ctx.store.deleteRecord(ctx.params.id);
  if (!removed) throw new HttpError(404, `记录不存在：${ctx.params.id}`);
  sendJson(ctx.res, { ok: true, deleted: ctx.params.id });
});

route('POST', '/api/records/bulk-delete', async (ctx) => {
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const ids = Array.isArray(body.ids) ? body.ids.map(asString) : splitCsv(body.ids);
  if (!ids.length) throw new HttpError(400, '缺少 ids');
  const removed = ctx.store.deleteRecords(ids);
  sendJson(ctx.res, { ok: true, requested: ids.length, deleted: removed });
});

route('POST', '/api/records/:id/attachments', async (ctx) => {
  const id = ctx.params.id;
  const existing = ctx.store.getRecord(id);
  if (!existing) throw new HttpError(404, `记录不存在：${id}`);
  const { record } = normalizeRecordPayload({ attachments: ctx.body }, { dataDir: DATA_DIR });
  const attachments = [...(existing.attachments || []), ...record.attachments];
  const updated = ctx.store.updateRecord(id, { attachments, updated_at: toIso(nowMs()), updated_at_ms: nowMs() });
  sendJson(ctx.res, { ok: true, added: record.attachments.length, record: updated }, 201);
});

/* ------------------------------- 筛选 / 统计 ------------------------------- */

route('GET', '/api/facets', async (ctx) => {
  const stats = ctx.store.stats();
  sendJson(ctx.res, {
    ok: true,
    models: stats.models,
    tags: stats.tags,
    types: stats.types,
    statuses: stats.statuses,
    reasoning_efforts: stats.reasoning_efforts,
    harnesses: stats.harnesses,
    batches: ctx.store.listBatches(),
    total: stats.total,
  });
});

route('GET', '/api/stats', async (ctx) => {
  const stats = ctx.store.stats();
  sendJson(ctx.res, { ok: true, ...stats, uptime_seconds: Math.round((nowMs() - STARTED_AT) / 1000) });
});

/* ------------------------------- 批次 ------------------------------- */

route('GET', '/api/batches', async (ctx) => {
  sendJson(ctx.res, { ok: true, batches: ctx.store.listBatches() });
});

route('POST', '/api/batches', async (ctx) => {
  const payload = normalizeBatchPayload(ctx.body || {});
  const existing = payload.name ? ctx.store.findBatchByName(payload.name) : null;
  if (existing) {
    sendJson(ctx.res, { ok: true, duplicate: true, batch: existing });
    return;
  }
  const batch = ctx.store.createBatch(payload);
  sendJson(ctx.res, { ok: true, batch }, 201);
});

route('PATCH', '/api/batches/:id', async (ctx) => {
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const batch = ctx.store.updateBatch(ctx.params.id, { name: body.name, note: body.note });
  if (!batch) throw new HttpError(404, `批次不存在：${ctx.params.id}`);
  sendJson(ctx.res, { ok: true, batch });
});

route('DELETE', '/api/batches/:id', async (ctx) => {
  const removed = ctx.store.deleteBatch(ctx.params.id);
  if (!removed) throw new HttpError(404, `批次不存在：${ctx.params.id}`);
  sendJson(ctx.res, { ok: true, deleted: ctx.params.id });
});

/* ------------------------------- 文件上传 ------------------------------- */

route('POST', '/api/files', async (ctx) => {
  const name = ctx.url.searchParams.get('name') || ctx.req.headers['x-filename'] || 'upload.bin';
  const mime = ctx.url.searchParams.get('mime') || ctx.req.headers['content-type'] || guessMime(name);
  const raw = ctx.rawBody;
  const forceRaw = ctx.url.searchParams.get('raw') === '1';

  if (raw && raw.length && (forceRaw || !/application\/json/i.test(ctx.req.headers['content-type'] || ''))) {
    const saved = saveFile(DATA_DIR, { name, mime, buffer: raw });
    sendJson(ctx.res, { ok: true, attachment: saved }, 201);
    return;
  }

  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const base64 = asString(body.base64 || body.data_base64 || body.dataBase64);
  const dataUrl = asString(body.data_url || body.dataUrl || body.data);
  let buffer = null;
  if (dataUrl.startsWith('data:')) {
    const parsed = normalizeRecordPayload({ attachments: [{ name: body.name || name, data_url: dataUrl }] }, { dataDir: DATA_DIR });
    if (parsed.record.attachments.length) {
      sendJson(ctx.res, { ok: true, attachment: parsed.record.attachments[0] }, 201);
      return;
    }
  }
  if (base64) buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
  if (!buffer) throw new HttpError(400, '请提供原始二进制（?name=xxx）或 JSON 里的 base64 / data_url');
  const saved = saveFile(DATA_DIR, { name: asString(body.name) || name, mime: asString(body.mime) || mime, buffer });
  sendJson(ctx.res, { ok: true, attachment: saved }, 201);
});

/* ------------------------------- 导出 ------------------------------- */

route('GET', '/api/export', async (ctx) => {
  const sp = ctx.url.searchParams;
  const format = (sp.get('format') || 'json').toLowerCase();
  const filter = parseListQuery(sp);
  filter.limit = clampInt(sp.get('limit'), 1, 200000, 200000);
  filter.offset = 0;
  filter.order = sp.get('order') === 'desc' ? 'desc' : 'asc';
  const page = ctx.store.listRecords(filter);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const download = sp.get('download') !== '0';

  if (format === 'csv') {
    const header = [
      'id',
      'created_at',
      'created_at_local',
      'title',
      'model',
      'provider',
      'reasoning_effort',
      'harness',
      'batch_name',
      'tags',
      'status',
      'result_type',
      'latency_ms',
      'tokens_in',
      'tokens_out',
      'cost',
      'prompt',
      'result',
      'error',
    ];
    const lines = [header.join(',')];
    for (const r of page.items) {
      lines.push(
        [
          r.id,
          r.created_at,
          r.created_at_local,
          r.title,
          r.model,
          r.provider,
          r.reasoning_effort,
          r.harness,
          r.batch_name,
          (r.tags || []).join('|'),
          r.status,
          r.result_type,
          r.latency_ms,
          r.tokens_in,
          r.tokens_out,
          r.cost,
          r.prompt,
          r.result,
          r.error,
        ]
          .map(csvCell)
          .join(','),
      );
    }
    sendText(ctx.res, `\uFEFF${lines.join('\r\n')}`, 200, 'text/csv; charset=utf-8', download ? { 'Content-Disposition': `attachment; filename="model-log-${stamp}.csv"` } : {});
    return;
  }

  if (format === 'ndjson') {
    const body = page.items.map((r) => JSON.stringify(r)).join('\n');
    sendText(ctx.res, body ? `${body}\n` : '', 200, 'application/x-ndjson; charset=utf-8', download ? { 'Content-Disposition': `attachment; filename="model-log-${stamp}.ndjson"` } : {});
    return;
  }

  const payload = {
    ok: true,
    exported_at: toIso(nowMs()),
    exported_at_local: formatLocal(nowMs()),
    backend: ctx.store.backend,
    count: page.items.length,
    total: page.total,
    records: page.items,
  };
  sendJson(ctx.res, payload, 200, download ? { 'Content-Disposition': `attachment; filename="model-log-${stamp}.json"` } : {});
});

/* ------------------------------- 结果直出页面 ------------------------------- */

route('GET', '/r/:id', async (ctx) => {
  const record = ctx.store.getRecord(ctx.params.id);
  if (!record) throw new HttpError(404, `记录不存在：${ctx.params.id}`);
  const sp = ctx.url.searchParams;
  const wantRaw = sp.get('raw') === '1' || sp.get('download') === '1';
  const partIndex = sp.get('part');
  let content = record.result;
  let type = record.result_type;
  if (partIndex !== null && record.parts && record.parts[Number(partIndex)]) {
    content = record.parts[Number(partIndex)].content;
    type = record.parts[Number(partIndex)].type;
  }

  const isFileLike = type === 'image' || type === 'file';
  const fileUrl = isFileLike ? asString(content).trim() : '';
  const fileBasename = (() => {
    const clean = fileUrl.split(/[?#]/)[0];
    const last = clean.split('/').filter(Boolean).pop() || '';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();

  if (sp.get('download') === '1') {
    // 文件型结果：直接把文件本身给出去
    if (isFileLike && /^(?:https?:)?\/\//.test(fileUrl)) {
      ctx.res.writeHead(302, { ...CORS_HEADERS, Location: fileUrl });
      ctx.res.end();
      return;
    }
    if (isFileLike && fileUrl.startsWith('/files/')) {
      const target = resolveDataFile(DATA_DIR, fileUrl);
      if (target && fs.existsSync(target)) {
        const buffer = fs.readFileSync(target);
        ctx.res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': guessMime(target),
          'Content-Length': buffer.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileBasename || 'result')}`,
        });
        ctx.res.end(buffer);
        return;
      }
    }
    const ext = type === 'html' ? 'html' : 'txt';
    const filename = `${(record.title || record.id).replace(/[\\/:*?"<>|]/g, '_')}.${ext}`;
    sendText(ctx.res, content, 200, type === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    return;
  }

  const isFullHtmlDocument = /<!doctype\s+html|<html[\s>]/i.test(asString(content));
  if (type === 'html' && (wantRaw || isFullHtmlDocument)) {
    sendText(ctx.res, content, 200, 'text/html; charset=utf-8');
    return;
  }

  const meta = [
    `<strong>${escapeHtmlText(record.model || '未填模型')}</strong>`,
    record.reasoning_effort ? `思考 ${escapeHtmlText(record.reasoning_effort)}` : '',
    record.harness ? `Harness ${escapeHtmlText(record.harness)}` : '',
    escapeHtmlText(record.title || '(无标题)'),
    `记录时间 ${record.created_at_local || ''}`,
    record.latency_ms ? `耗时 ${record.latency_ms} ms` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const lowerUrl = fileUrl.toLowerCase();
  const body =
    type === 'html'
      ? content
      : type === 'image'
        ? `<div class="filewrap"><img src="${escapeAttrText(fileUrl)}" alt="${escapeAttrText(fileBasename)}"></div>`
        : type === 'file' && /\.pdf($|\?)/.test(lowerUrl)
          ? `<iframe class="fileframe" src="${escapeAttrText(fileUrl)}" title="${escapeAttrText(fileBasename)}"></iframe>`
          : type === 'file' && /\.(mp4|webm|mov)($|\?)/.test(lowerUrl)
            ? `<div class="filewrap"><video controls src="${escapeAttrText(fileUrl)}"></video></div>`
            : type === 'file' && /\.(mp3|wav|ogg|flac)($|\?)/.test(lowerUrl)
              ? `<div class="filewrap"><audio controls src="${escapeAttrText(fileUrl)}"></audio></div>`
              : isFileLike
                ? `<div class="filecard">
        <div class="filename">${escapeHtmlText(fileBasename || fileUrl || '未命名文件')}</div>
        <div class="filerow">
          <a class="primary" href="${escapeAttrText(fileUrl)}" download>下载文件</a>
          <a href="${escapeAttrText(fileUrl)}" target="_blank" rel="noopener">在新窗口打开</a>
        </div>
      </div>`
                : `<pre class="raw">${escapeHtmlText(content)}</pre>`;

  const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlText(record.title || record.id)} · 模型测试记录台</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;background:#f7f7f5;color:#111827;font:14px/1.6 Inter,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  header{position:sticky;top:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 16px;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid #e5e7eb;font-size:12.5px;color:#4b5563}
  header .spacer{flex:1}
  header a{color:#111827;text-decoration:none;border:1px solid #d1d5db;border-radius:8px;padding:4px 10px;background:#fff}
  main{padding:0}
  .raw{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}
  .filewrap{display:grid;place-items:center;padding:16px}
  .filewrap img,.filewrap video{max-width:100%;max-height:82vh;border-radius:8px}
  .fileframe{display:block;width:100%;height:88vh;border:0}
  .filecard{display:grid;gap:14px;place-items:center;margin:48px auto;padding:28px;max-width:520px;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  .filecard .filename{font-size:15px;font-weight:600;word-break:break-all;text-align:center}
  .filecard .filerow{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .filecard a{display:inline-block;padding:7px 14px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb}
  .filecard a.primary{background:#050505;color:#fff;border-color:transparent}
  @media (prefers-color-scheme: dark){
    body{background:#151513;color:#f4f1ea}
    header{background:rgba(32,32,29,.92);border-color:#34332f;color:#b4b0a7}
    header a{background:#24231f;border-color:#45443d;color:#f4f1ea}
    .filecard{background:#20201d;border-color:#34332f}
    .filecard a{background:#24231f;border-color:#45443d}
    .filecard a.primary{background:#1e90ff;border-color:transparent}
  }
</style></head>
<body>
<header><span>${meta}</span><span class="spacer"></span><a href="${ctx.baseUrl}/?record=${encodeURIComponent(record.id)}">在记录台打开</a><a href="${ctx.baseUrl}/api/records/${encodeURIComponent(record.id)}">API</a></header>
<main>${body}</main>
</body></html>`;
  sendText(ctx.res, page, 200, 'text/html; charset=utf-8');
});

function escapeHtmlText(s) {
  return asString(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 属性值转义（同样覆盖引号，避免属性被截断） */
const escapeAttrText = escapeHtmlText;

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.join(PUBLIC_DIR, rel);
  if (!path.resolve(target).startsWith(path.resolve(PUBLIC_DIR))) {
    sendText(res, '403 Forbidden', 403);
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  const type = MIME_BY_EXT[ext] || 'application/octet-stream';
  sendBuffer(res, fs.readFileSync(target), type, { 'Cache-Control': 'no-cache' });
  return true;
}

function serveDataFile(req, res, pathname) {
  const decoded = decodeURIComponent(pathname.replace(/^\/files\//, ''));
  const target = resolveDataFile(DATA_DIR, decoded);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendText(res, '404 Not Found', 404);
    return;
  }
  const type = guessMime(target);
  sendBuffer(res, fs.readFileSync(target), type, { 'Cache-Control': 'public, max-age=31536000, immutable' });
}

/* ------------------------------------------------------------------ *
 * 服务器
 * ------------------------------------------------------------------ */

async function main() {
  const store = await openStore(DATA_DIR);

  if (SEED) {
    const stats = store.stats();
    if (stats.total === 0) {
      for (const record of buildSeedRecords(DATA_DIR)) store.insertRecord(record);
      if (!QUIET) console.log('  已写入 3 条示例记录（--no-seed 可跳过）');
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, store).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) {
        sendJson(res, { ok: false, error: err && err.message ? err.message : String(err), status }, status);
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      if (status >= 500 && !QUIET) console.error('[error]', err);
    });
  });

  const actualPort = await listenWithFallback(server, HOST, PORT);

  if (!QUIET) {
    const urls = [`http://127.0.0.1:${actualPort}`];
    if (HOST === '0.0.0.0' || HOST === '::') {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const info of list || []) {
          if (info.family === 'IPv4' && !info.internal) urls.push(`http://${info.address}:${actualPort}`);
        }
      }
    }
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log(`  │  模型测试记录台  v${VERSION}                        │`);
    console.log('  └──────────────────────────────────────────────┘');
    console.log(`  界面      ${urls[0]}`);
    if (urls.length > 1) console.log(`  局域网    ${urls.slice(1).join('  ')}`);
    console.log(`  登记接口  POST ${urls[0]}/api/records   （无需鉴权）`);
    console.log(`  接口自述  GET  ${urls[0]}/api/help`);
    console.log(`  存储      ${store.backend === 'sqlite' ? path.join(DATA_DIR, 'records.db') : path.join(DATA_DIR, 'records.json')}${store.fallbackReason ? `（回退原因：${store.fallbackReason}）` : ''}`);
    console.log(`  附件目录  ${path.join(DATA_DIR, 'files')}`);
    console.log(`  当前时间  ${formatLocal(nowMs())} (UTC${localOffset()})`);
    console.log('');
    console.log('  停止服务：Ctrl+C');
    console.log('');
  }

  const shutdown = () => {
    if (!QUIET) console.log('\n  正在保存并退出…');
    try {
      store.close();
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 监听端口。--port 0 表示让系统随便挑一个空闲端口（测试用，永远不会撞端口）；
 * 指定端口被占用时自动往后找一个。
 */
function listenWithFallback(server, host, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    let current = port;
    const tryListen = () => {
      const onError = (err) => {
        if (err && err.code === 'EADDRINUSE' && current !== 0 && current < port + attempts) {
          current += 1;
          setTimeout(tryListen, 30);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(current, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(address && typeof address === 'object' ? address.port : current);
      });
    };
    tryListen();
  });
}

async function handleRequest(req, res, store) {
  const baseUrl = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  const url = new URL(req.url || '/', baseUrl);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const matched = matchRoute(req.method, pathname);
  if (matched && matched.entry) {
    const isWrite = ['POST', 'PATCH', 'PUT'].includes(req.method);
    const rawBody = isWrite ? await readBody(req, MAX_BODY) : Buffer.alloc(0);
    const body = isWrite ? parseBodyBuffer(rawBody, req.headers['content-type']) : {};
    const ctx = {
      req,
      res,
      url,
      params: matched.params,
      body,
      rawBody,
      store,
      baseUrl,
    };
    await matched.entry.handler(ctx);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname.startsWith('/files/')) {
      serveDataFile(req, res, pathname);
      return;
    }
    if (serveStatic(req, res, pathname)) return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, { ok: false, error: `未知接口 ${req.method} ${pathname}`, hint: `GET ${baseUrl}/api/help` }, 404);
    return;
  }

  sendText(res, '404 Not Found', 404);
}

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
