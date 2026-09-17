// 请求负载归一化：把各种「随便写」的字段名统一成内部记录结构。
// 设计目标：调用方（脚本 / 其他工具 / curl / 网页）不需要精确记住字段名，
// 常见别名都能识别；无法识别的字段一律原样塞进 meta 不丢数据。

import {
  newId,
  nowMs,
  toIso,
  asString,
  firstDefined,
  firstString,
  toStringArray,
  toIntOrNull,
  toFloatOrNull,
  toBoolOrNull,
  inferResultType,
  deriveTitle,
  isPlainObject,
  parseTimeToMs,
  formatLocal,
  safeDecodeURI,
  truncate,
} from './util.mjs';
import { saveFile, parseDataUrl, guessMime, isImageMime } from './files.mjs';

/** 规范字段 -> 可接受的别名列表（顺序即优先级） */
const ALIASES = {
  prompt: ['prompt', 'prompt_text', 'promptText', 'input', 'inputs', 'user_prompt', 'userPrompt', 'question', 'ask', 'query'],
  messages: ['messages', 'conversation', 'chat', 'history'],
  model: ['model', 'model_name', 'modelName', 'model_id', 'modelId', 'engine', 'model_key'],
  provider: ['provider', 'vendor', 'channel', 'platform', 'api', 'endpoint'],
  result: ['result', 'output', 'outputs_text', 'response', 'content', 'answer', 'completion', 'output_text', 'outputText', 'reply', 'text', 'html'],
  parts: ['parts', 'results', 'outputs', 'items', 'segments', 'blocks'],
  title: ['title', 'name', 'label', 'subject'],
  tags: ['tags', 'tag', 'labels', 'keywords'],
  batch: ['batch', 'batch_name', 'batchName', 'group', 'group_name', 'groupName', 'session', 'run', 'run_id', 'runId', 'test_id', 'testId', 'suite', 'case_name'],
  batch_id: ['batch_id', 'batchId'],
  status: ['status', 'state'],
  ok: ['ok', 'success', 'passed', 'pass', 'succeeded'],
  error: ['error', 'error_message', 'errorMessage', 'err', 'failure', 'exception'],
  latency_ms: ['latency_ms', 'latencyMs', 'latency', 'duration_ms', 'durationMs', 'elapsed_ms', 'elapsedMs', 'duration', 'elapsed', 'took_ms', 'tookMs', 'time_cost_ms'],
  tokens_in: ['tokens_in', 'tokensIn', 'prompt_tokens', 'promptTokens', 'input_tokens', 'inputTokens', 'usage_prompt_tokens'],
  tokens_out: ['tokens_out', 'tokensOut', 'completion_tokens', 'completionTokens', 'output_tokens', 'outputTokens', 'usage_completion_tokens'],
  total_tokens: ['total_tokens', 'totalTokens'],
  cost: ['cost', 'price', 'usd', 'fee', 'expense'],
  currency: ['currency', 'unit', 'cost_unit'],
  created_at: ['created_at', 'createdAt', 'time', 'timestamp', 'ts', 'date', 'datetime', 'created', 'logged_at', 'loggedAt'],
  source: ['source', 'origin', 'client', 'app'],
  idempotency_key: ['idempotency_key', 'idempotencyKey', 'request_id', 'requestId', 'trace_id', 'traceId', 'dedupe_key', 'dedupeKey', 'run_key'],
  attachments: ['attachments', 'files', 'images', 'image', 'image_url', 'imageUrl', 'screenshot', 'screenshots', 'artifacts', 'assets'],
  note: ['note', 'notes', 'remark', 'comment', 'memo'],
  meta: ['meta', 'metadata', 'extra', 'extras', 'details', 'context'],
  result_type: ['result_type', 'resultType', 'format', 'output_type', 'outputType', 'content_type', 'contentType', 'type'],
};

const KNOWN_KEYS = new Set();
for (const list of Object.values(ALIASES)) for (const key of list) KNOWN_KEYS.add(key);
KNOWN_KEYS.add('id');
KNOWN_KEYS.add('record_id');
KNOWN_KEYS.add('recordId');
KNOWN_KEYS.add('_id');

function picker(raw) {
  const lowered = new Map();
  for (const key of Object.keys(raw)) lowered.set(key.toLowerCase(), key);
  return (canonical) => {
    const aliases = ALIASES[canonical] || [canonical];
    const values = [];
    for (const alias of aliases) {
      const actual = Object.prototype.hasOwnProperty.call(raw, alias) ? alias : lowered.get(alias.toLowerCase());
      if (actual !== undefined) values.push(raw[actual]);
    }
    return firstDefined(...values);
  };
}

/** 把 messages 数组拼成可读提示词 */
function formatMessages(messages) {
  if (!Array.isArray(messages)) return asString(messages);
  const lines = [];
  for (const msg of messages) {
    if (msg === null || msg === undefined) continue;
    if (typeof msg === 'string') {
      lines.push(msg);
      continue;
    }
    if (isPlainObject(msg)) {
      const role = asString(firstDefined(msg.role, msg.author, msg.speaker, 'user')).trim() || 'user';
      const content = firstDefined(msg.content, msg.text, msg.message, msg.value);
      let text = '';
      if (Array.isArray(content)) {
        text = content
          .map((part) => (isPlainObject(part) ? firstString(part.text, part.content, part.value) : asString(part)))
          .filter(Boolean)
          .join('\n');
      } else {
        text = asString(content);
      }
      lines.push(`[${role}]\n${text}`.trim());
    }
  }
  return lines.join('\n\n');
}

function normalizePart(item, fallbackType) {
  if (item === null || item === undefined) return null;
  if (typeof item !== 'object') {
    const content = asString(item);
    if (!content) return null;
    return { type: fallbackType || inferResultType(content), label: '', content, mime: '' };
  }
  const rawContent = firstDefined(item.content, item.value, item.text, item.html, item.markdown, item.body, item.data, item.output, item.result);
  const content = asString(rawContent);
  const explicitType = firstString(item.type, item.kind, item.format, item.mime, item.content_type);
  let type = '';
  const lower = explicitType.toLowerCase();
  if (lower.includes('html')) type = 'html';
  else if (lower.includes('markdown') || lower === 'md') type = 'markdown';
  else if (lower.includes('json')) type = 'json';
  else if (lower.includes('image') || lower.startsWith('image/')) type = 'image';
  else if (lower.includes('code') || lower.includes('script')) type = 'code';
  else if (lower.includes('text') || lower === 'txt') type = 'text';
  if (!type) type = fallbackType || inferResultType(content);
  if (!content && !item.url) return null;
  return {
    type,
    label: firstString(item.label, item.name, item.title),
    content: content || asString(item.url),
    mime: firstString(item.mime, item.content_type),
  };
}

/** 处理附件：data URL / base64 落盘，http(s) 保留远程引用 */
function collectAttachments(rawValue, dataDir) {
  const out = [];
  const items = Array.isArray(rawValue) ? rawValue : [rawValue];
  for (const item of items) {
    if (item === null || item === undefined || item === '') continue;
    if (Array.isArray(item)) {
      out.push(...collectAttachments(item, dataDir));
      continue;
    }
    if (typeof item === 'string') {
      const s = item.trim();
      if (!s) continue;
      if (s.startsWith('data:')) {
        const saved = saveAttachmentValue({ data: s }, dataDir);
        if (saved) out.push(saved);
      } else if (/^(?:https?:)?\/\//i.test(s) || s.startsWith('/files/')) {
        const saved = saveAttachmentValue({ url: s }, dataDir);
        if (saved) out.push(saved);
      } else {
        out.push(saveFile(dataDir, { name: 'attachment.txt', mime: 'text/plain', buffer: Buffer.from(s, 'utf8') }));
      }
      continue;
    }
    if (!isPlainObject(item)) continue;
    const saved = saveAttachmentValue(item, dataDir);
    if (saved) out.push(saved);
  }
  return out;
}

function saveAttachmentValue(item, dataDir) {
  const name = firstString(item.name, item.filename, item.file_name, item.fileName, item.title);
  const directUrl = firstString(item.url, item.href, item.link, item.src, item.image_url, item.imageUrl);
  const declaredMime = firstString(item.mime, item.content_type, item.contentType);
  const url = typeof item.url === 'string' ? item.url : '';
  const src = typeof item.src === 'string' ? item.src : '';

  // 1) data URL
  const dataUrlCandidate = [item.data_url, item.dataUrl, item.content_base64, item.content, item.data].find(
    (v) => typeof v === 'string' && v.startsWith('data:'),
  );
  if (typeof dataUrlCandidate === 'string') {
    const parsed = parseDataUrl(dataUrlCandidate);
    if (parsed) {
      return saveFile(dataDir, {
        name: name || `attachment${extSuffix(parsed.mime)}`,
        mime: declaredMime || parsed.mime,
        buffer: parsed.buffer,
      });
    }
  }

  // 2) base64 字段
  const base64Candidate = [item.base64, item.data_base64, item.dataBase64, item.b64, item.content_base64].find((v) => typeof v === 'string' && v);
  if (base64Candidate) {
    const mime = declaredMime || 'application/octet-stream';
    return saveFile(dataDir, {
      name: name || `attachment${extSuffix(mime)}`,
      mime,
      buffer: Buffer.from(base64Candidate.replace(/\s+/g, ''), 'base64'),
    });
  }

  // 3) http(s) 远程引用
  if (directUrl && /^(?:https?:)?\/\//i.test(directUrl)) {
    const mime = declaredMime || guessMime(directUrl);
    return {
      id: newId('att'),
      kind: isImageMime(mime, directUrl) ? 'image' : 'file',
      name: name || baseName(directUrl) || 'remote',
      mime,
      size: toIntOrNull(item.size),
      path: '',
      url: directUrl,
      remote: true,
      created_at: toIso(nowMs()),
    };
  }

  // 4) 已落盘的 /files/ 引用
  if (url.startsWith('/files/') || src.startsWith('/files/')) {
    const ref = url.startsWith('/files/') ? url : src;
    return {
      id: newId('att'),
      kind: isImageMime(declaredMime, ref) ? 'image' : 'file',
      name: name || baseName(ref) || 'file',
      mime: declaredMime || guessMime(ref),
      size: toIntOrNull(item.size),
      path: safeDecodeURI(ref.replace(/^\/?files\//, 'files/')),
      url: ref,
      remote: false,
      created_at: toIso(nowMs()),
    };
  }

  // 5) 纯文本内容落盘
  const textCandidate = [item.content, item.text, item.data].find((v) => typeof v === 'string' && v);
  if (textCandidate) {
    const mime = declaredMime || 'text/plain';
    return saveFile(dataDir, { name: name || 'attachment.txt', mime, buffer: Buffer.from(textCandidate, 'utf8') });
  }
  return null;
}

function baseName(value) {
  const s = asString(value).split(/[?#]/)[0];
  const parts = s.split('/').filter(Boolean);
  return parts.length ? safeDecodeURI(parts[parts.length - 1]) : '';
}

function extSuffix(mime) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
  return map[asString(mime).toLowerCase()] || '';
}

function normalizeStatus(rawStatus, okValue, errorText, type) {
  const explicit = asString(rawStatus).trim().toLowerCase();
  if (explicit) {
    if (['ok', 'success', 'succeeded', 'passed', 'pass', 'done', 'completed', '完成', '成功'].includes(explicit)) return 'ok';
    if (['error', 'fail', 'failed', 'failure', 'exception', '失败', '报错'].includes(explicit)) return 'error';
    if (['pending', 'queued', '等待'].includes(explicit)) return 'pending';
    if (['running', 'running', '进行中'].includes(explicit)) return 'running';
    if (['skipped', 'skip', '跳过'].includes(explicit)) return 'skipped';
    return explicit;
  }
  const bool = toBoolOrNull(okValue);
  if (bool === false) return 'error';
  if (errorText) return 'error';
  if (type === 'error') return 'error';
  return 'ok';
}

/**
 * 归一化一条登记的记录。
 * @returns {{ record: object, warnings: string[] }}
 */
export function normalizeRecordPayload(rawInput, options = {}) {
  const dataDir = options.dataDir;
  const warnings = [];
  let raw = rawInput;

  if (typeof raw === 'string') raw = { result: raw };
  if (!isPlainObject(raw)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象（或字符串形式的模型结果）'), { status: 400 });
  }

  const get = picker(raw);
  const explicitType = asString(get('result_type')).trim().toLowerCase();

  /* ----------------------- 提示词 ----------------------- */
  let prompt = asString(get('prompt'));
  const messages = get('messages');
  if (!prompt && messages !== undefined) prompt = formatMessages(messages);
  if (!prompt && messages !== undefined) warnings.push('prompt 由 messages 拼接生成');

  /* ----------------------- 结果 ----------------------- */
  const rawParts = get('parts');
  let parts = [];
  if (Array.isArray(rawParts) && rawParts.length) {
    parts = rawParts.map((item) => normalizePart(item, '')).filter(Boolean);
  } else if (raw.html !== undefined && raw.text !== undefined && !raw.result && !raw.output) {
    // 同时给了 text 与 html，做成多段结果
    parts = [
      { type: 'text', label: '文本', content: asString(raw.text), mime: '' },
      { type: 'html', label: 'HTML', content: asString(raw.html), mime: '' },
    ].filter((p) => p.content);
  }

  let result = parts.length ? parts.map((p) => p.content).join('\n\n') : asString(get('result'));
  let resultType = explicitType || (parts.length > 1 ? 'mixed' : parts.length === 1 ? parts[0].type : '');

  if (!resultType) {
    resultType = inferResultType(result);
  }
  if (resultType === 'mixed' && parts.length === 0) {
    parts = [{ type: 'text', label: '', content: result, mime: '' }];
  }
  if (parts.length === 1 && resultType === 'mixed') resultType = parts[0].type;

  /* ----------------------- 附件 ----------------------- */
  let attachments = [];
  const rawAttachments = get('attachments');
  if (rawAttachments !== undefined) attachments = collectAttachments(rawAttachments, dataDir);

  // 图片型结果如果是 base64，落盘换成可访问 URL
  if (resultType === 'image' && /^data:image\//i.test(result.trim())) {
    const parsed = parseDataUrl(result.trim());
    if (parsed) {
      const saved = saveFile(dataDir, { name: `result${extSuffix(parsed.mime)}`, mime: parsed.mime, buffer: parsed.buffer });
      result = saved.url;
      if (!attachments.some((a) => a.url === saved.url)) attachments.push(saved);
    }
  }
  if (resultType === 'mixed' && parts.length) {
    parts = parts.map((part) => {
      if (part.type === 'image' && /^data:image\//i.test(part.content.trim())) {
        const parsed = parseDataUrl(part.content.trim());
        if (parsed) {
          const saved = saveFile(dataDir, { name: `part${extSuffix(parsed.mime)}`, mime: parsed.mime, buffer: parsed.buffer });
          attachments.push(saved);
          return { ...part, content: saved.url };
        }
      }
      return part;
    });
  }

  /* ----------------------- 元信息 ----------------------- */
  const metaRaw = get('meta');
  const meta = isPlainObject(metaRaw) ? { ...metaRaw } : {};
  if (metaRaw !== undefined && !isPlainObject(metaRaw)) meta._meta = metaRaw;
  const unknown = {};
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN_KEYS.has(key)) continue;
    unknown[key] = value;
  }
  if (Object.keys(unknown).length) meta._extra = { ...(isPlainObject(meta._extra) ? meta._extra : {}), ...unknown };
  const note = asString(get('note'));
  if (note) meta.note = note;
  if (messages !== undefined) meta.messages = messages;

  /* ----------------------- 其他字段 ----------------------- */
  const errorText = asString(get('error'));
  const status = normalizeStatus(get('status'), get('ok'), errorText, resultType);
  if (status === 'error' && !resultType) resultType = 'error';

  const createdAtRaw = get('created_at');
  const fallbackMs = nowMs();
  let createdAtMs = fallbackMs;
  const createdAtText = asString(createdAtRaw).trim();
  if (createdAtText) {
    const parsedCheck = parseTimeToMs(createdAtRaw, NaN);
    if (Number.isFinite(parsedCheck)) {
      createdAtMs = parsedCheck;
      meta._client_created_at = createdAtText;
    } else {
      meta._unparsed_created_at = createdAtText;
      warnings.push(`created_at 无法解析（${truncate(createdAtText, 40)}），已改用服务器当前时间`);
    }
  }

  const tokensIn = toIntOrNull(get('tokens_in'));
  const tokensOut = toIntOrNull(get('tokens_out'));
  let totalTokens = toIntOrNull(get('total_tokens'));
  if (totalTokens === null && (tokensIn !== null || tokensOut !== null)) totalTokens = (tokensIn || 0) + (tokensOut || 0);

  const batchName = asString(get('batch')).trim();
  const batchId = asString(get('batch_id')).trim();

  const model = asString(get('model'));
  const title = asString(get('title')).trim() || deriveTitle(prompt, result);
  if (!prompt && !result && !attachments.length) warnings.push('这条记录没有提示词也没有结果内容');

  const ms = createdAtMs;
  const record = {
    id: asString(firstDefined(raw.id, raw.record_id, raw.recordId)) || newId('rec'),
    title,
    prompt,
    model,
    provider: asString(get('provider')),
    batch_id: batchId || null,
    batch_name: batchName || '',
    tags: toStringArray(get('tags')),
    status,
    result_type: resultType || 'text',
    result,
    parts,
    error: errorText,
    latency_ms: toIntOrNull(get('latency_ms')),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    total_tokens: totalTokens,
    cost: toFloatOrNull(get('cost')),
    currency: asString(get('currency')) || (get('cost') !== undefined ? 'USD' : ''),
    meta,
    attachments,
    source: asString(get('source')) || options.source || 'api',
    idempotency_key: asString(get('idempotency_key')).trim() || null,
    created_at: toIso(ms),
    created_at_ms: ms,
    created_at_local: formatLocal(ms),
    updated_at: toIso(fallbackMs),
    updated_at_ms: fallbackMs,
  };

  return { record, warnings };
}

/** 归一化批次创建请求 */
export function normalizeBatchPayload(raw, options = {}) {
  const input = isPlainObject(raw) ? raw : {};
  const name = firstString(input.name, input.title, input.batch, input.batch_name, options.name).trim();
  if (!name) throw Object.assign(new Error('batch 缺少 name'), { status: 400 });
  return {
    id: firstString(input.id, input.batch_id, input.batchId) || undefined,
    name,
    note: asString(firstDefined(input.note, input.notes, input.remark, input.comment)),
  };
}

/** 生成示例记录（首次启动种子数据） */
export function buildSeedRecords(dataDir) {
  const now = nowMs();
  const samples = [
    {
      title: '示例 · 文本结果',
      prompt: '用三句话解释什么是 RAG（检索增强生成）。',
      model: 'deepseek-v4-flash',
      provider: 'demo',
      tags: ['示例', '文本'],
      result_type: 'text',
      result:
        'RAG 是把「检索」和「生成」拼在一起的做法：先从你自己的资料库里找出与问题最相关的片段，再把这些片段作为上下文交给大模型。\n这样模型不必把所有知识都背进参数里，回答能引用真实资料，也更容易更新和维护。\n代价是链路变长——检索质量、切分策略和提示词组织都会直接影响最终答案。',
      latency_ms: 1840,
      tokens_in: 62,
      tokens_out: 208,
      cost: 0.0003,
      created_at_ms: now - 1000 * 60 * 52,
      source: 'seed',
      meta: { note: '这是首次启动自动写入的示例记录，可在界面里直接删除。' },
    },
    {
      title: '示例 · HTML 结果（沙箱渲染）',
      prompt: '生成一个深色主题的模型跑分卡片，包含模型名、分数和进度条，输出完整 HTML。',
      model: 'gpt-5.1-codex',
      provider: 'demo',
      tags: ['示例', 'HTML', '渲染'],
      result_type: 'html',
      result: [
        '<!doctype html>',
        '<html lang="zh-CN"><head><meta charset="utf-8"><title>模型跑分卡</title>',
        '<style>',
        '  body{margin:0;padding:20px;background:#151513;color:#f4f1ea;font-family:Inter,system-ui,"PingFang SC",sans-serif}',
        '  .card{max-width:420px;border:1px solid #34332f;border-radius:12px;background:#20201d;padding:18px}',
        '  .row{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 6px}',
        '  .bar{height:8px;border-radius:999px;background:#2c2b27;overflow:hidden}',
        '  .bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#c96442,#e0a06a)}',
        '  .muted{color:#8f8a82;font-size:12px;margin-top:10px}',
        '</style></head><body>',
        '<div class="card">',
        '  <div class="row"><strong>gpt-5.1-codex</strong><span>91.4</span></div>',
        '  <div class="bar"><i style="width:91.4%"></i></div>',
        '  <div class="muted">HumanEval+ · 生成于 2026-09-17 · 该卡片运行在沙箱 iframe 中</div>',
        '</div>',
        '<button onclick="this.textContent=\'脚本已执行 \'+new Date().toLocaleTimeString()" style="margin-top:14px;padding:8px 12px;border-radius:8px;border:1px solid #45443d;background:#24231f;color:#f4f1ea">点我验证 JS 可运行</button>',
        '</body></html>',
      ].join('\n'),
      latency_ms: 6120,
      tokens_in: 88,
      tokens_out: 1520,
      cost: 0.0124,
      created_at_ms: now - 1000 * 60 * 60 * 5,
      source: 'seed',
      meta: { note: 'HTML 结果在列表里以沙箱 iframe 渲染，可切「源码」和「新窗口打开」。' },
    },
    {
      title: '示例 · 多段结果（文本 + 表格）',
      prompt: '对比 gpt-5.1 与 claude-sonnet-5 在代码补全上的表现，给出简要结论和 Markdown 表格。',
      model: 'claude-sonnet-5',
      provider: 'demo',
      tags: ['示例', 'Markdown', '对比'],
      result_type: 'markdown',
      result: [
        '## 结论',
        '',
        '两者差距不大，**长函数补全**上 claude-sonnet-5 更稳，**跨文件重构**上 gpt-5.1 更完整。',
        '',
        '| 维度 | gpt-5.1 | claude-sonnet-5 |',
        '| --- | --- | --- |',
        '| 单文件补全 | 87% | 89% |',
        '| 跨文件重构 | 82% | 78% |',
        '| 平均延迟 | 3.1s | 2.6s |',
        '',
        '> 样本量 240，单次运行，仅供参考。',
        '',
        '```js',
        'const score = models.map(m => m.score).reduce((a, b) => a + b, 0);',
        '```',
      ].join('\n'),
      latency_ms: 2740,
      tokens_in: 74,
      tokens_out: 386,
      cost: 0.0021,
      created_at_ms: now - 1000 * 60 * 60 * 26,
      source: 'seed',
      meta: { note: 'Markdown 结果由内置渲染器直接渲染，代码块会保留等宽样式。' },
    },
  ];

  return samples.map((sample) => {
    const ms = sample.created_at_ms;
    return {
      id: newId('rec'),
      title: sample.title,
      prompt: sample.prompt,
      model: sample.model,
      provider: sample.provider,
      batch_id: null,
      batch_name: '',
      tags: sample.tags || [],
      status: 'ok',
      result_type: sample.result_type,
      result: sample.result,
      parts: [],
      error: '',
      latency_ms: sample.latency_ms ?? null,
      tokens_in: sample.tokens_in ?? null,
      tokens_out: sample.tokens_out ?? null,
      total_tokens: (sample.tokens_in || 0) + (sample.tokens_out || 0) || null,
      cost: sample.cost ?? null,
      currency: 'USD',
      meta: sample.meta || {},
      attachments: [],
      source: sample.source || 'seed',
      idempotency_key: null,
      created_at: toIso(ms),
      created_at_ms: ms,
      updated_at: toIso(ms),
      updated_at_ms: ms,
    };
  });
}
