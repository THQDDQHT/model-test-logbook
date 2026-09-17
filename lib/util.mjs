// 通用工具函数：ID、时间、类型转换、JSON、HTML 转义等。
// 全部零依赖，纯 Node 内置能力。

import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * ID
 * ------------------------------------------------------------------ */

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 生成带前缀、按时间大致有序的 ID，例如 rec_m3k9x2_7f3a1c */
export function newId(prefix = 'rec') {
  const ts = Date.now().toString(36);
  const bytes = crypto.randomBytes(5);
  let rand = '';
  for (const b of bytes) rand += ID_ALPHABET[b % ID_ALPHABET.length];
  return `${prefix}_${ts}_${rand}`;
}

/** 生成短随机串 */
export function randomToken(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

export function nowMs() {
  return Date.now();
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

/** 本地时间格式：2026-09-17 11:48:03 */
export function formatLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 本地时区偏移，例如 +08:00 */
export function localOffset(ms = Date.now()) {
  const min = -new Date(ms).getTimezoneOffset();
  const sign = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * 把各种形态的时间解析成毫秒时间戳。
 * 支持：毫秒数、秒数、ISO 字符串、'2026-09-17 11:48'、'2026-09-17'、Date。
 * 解析失败返回 fallback。
 */
export function parseTimeToMs(value, fallback = Date.now()) {
  if (value === null || value === undefined || value === '') return fallback;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : fallback;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fallback;
    return Math.abs(value) < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const raw = String(value).trim();
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  if (/^\d{16}$/.test(raw)) return Math.round(Number(raw) / 1000);
  // 'YYYY-MM-DD' 单独出现时按本地 0 点处理
  let text = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00:00`;
  // 'YYYY-MM-DD HH:mm(:ss)' 在 V8 中已按本地时间解析，这里显式替换更稳
  text = text.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/, '$1T$2');
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  const fallbackParse = Date.parse(raw);
  return Number.isFinite(fallbackParse) ? fallbackParse : fallback;
}

/* ------------------------------------------------------------------ *
 * 类型与取值
 * ------------------------------------------------------------------ */

export function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function asString(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return v.message || String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function firstString(...values) {
  const v = firstDefined(...values);
  return v === undefined ? '' : asString(v);
}

export function toStringArray(v) {
  if (v === null || v === undefined || v === '') return [];
  const list = Array.isArray(v) ? v : String(v).split(/[,，;；\n|]/);
  const out = [];
  for (const item of list) {
    const s = asString(item).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

export function toIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function toFloatOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toBoolOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on', 'ok', 'success', '成功'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'fail', 'failed', 'error', '失败'].includes(s)) return false;
  return null;
}

export function clampInt(v, min, max, fallback) {
  // 注意：Number(null) === 0，所以必须先把「没传」和「传了 0」区分开
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function truncate(s, n) {
  const str = asString(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

export function byteLength(s) {
  return Buffer.byteLength(asString(s), 'utf8');
}

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

export function safeJsonParse(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  if (typeof text === 'object') return text;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function stableStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * SQL LIKE 转义
 * ------------------------------------------------------------------ */

export function escapeLike(s) {
  return asString(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* ------------------------------------------------------------------ *
 * HTML / CSV 转义
 * ------------------------------------------------------------------ */

/** decodeURIComponent 的安全版本：遇到非法百分号编码时原样返回，不抛异常 */
export function safeDecodeURI(s) {
  const text = asString(s);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function escapeHtml(s) {
  return asString(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function csvCell(v) {
  const s = asString(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/* ------------------------------------------------------------------ *
 * 结果类型推断
 * ------------------------------------------------------------------ */

const HTML_HINT = /<\/?(?:!doctype|html|head|body|div|section|article|main|aside|header|footer|nav|table|thead|tbody|tr|td|th|ul|ol|li|p|span|a|img|svg|style|script|h[1-6]|br|hr|form|input|button|canvas|iframe|video|audio|meta|link)\b/i;

export function looksLikeHtml(text) {
  const s = asString(text);
  if (!s) return false;
  if (/^\s*<!doctype html/i.test(s)) return true;
  if (!HTML_HINT.test(s)) return false;
  // 至少出现两个标签，避免把「a < b > c」误判为 HTML
  const tags = s.match(/<[a-zA-Z!/][^>]{0,200}>/g);
  return !!tags && tags.length >= 2;
}

export function looksLikeJson(text) {
  const s = asString(text).trim();
  if (!s) return false;
  if (!/^[[{]/.test(s)) return false;
  if (!/[\]}]$/.test(s)) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

export function looksLikeMarkdown(text) {
  const s = asString(text);
  if (!s) return false;
  if (/```/.test(s)) return true;
  if (/^#{1,6}\s+\S/m.test(s)) return true;
  if (/^\s*[-*+]\s+\S/m.test(s) && /\n/.test(s)) return true;
  if (/\[[^\]]+\]\([^)]+\)/.test(s)) return true;
  if (/^\s*\|.+\|\s*$/m.test(s) && /\|\s*-{2,}/.test(s.replace(/\n/g, ' '))) return true;
  return false;
}

const FILE_EXT_HINT = /\.(pdf|zip|rar|7z|tar|gz|docx?|xlsx?|pptx?|csv|txt|md|json|xml|ya?ml|mp4|webm|mov|mp3|wav|ogg|flac|ttf|otf|woff2?|psd|ai|sketch|fig)(\?\S*)?$/i;

/** 依据内容推断展示类型 */
export function inferResultType(text, hint = '') {
  const h = asString(hint).toLowerCase();
  if (h) {
    if (['html', 'htm', 'web', 'page'].includes(h)) return 'html';
    if (['md', 'markdown'].includes(h)) return 'markdown';
    if (['json'].includes(h)) return 'json';
    if (['code', 'source', 'script'].includes(h)) return 'code';
    if (['image', 'img', 'picture', 'photo'].includes(h)) return 'image';
    if (['file', 'attachment', 'binary', 'document', 'doc'].includes(h)) return 'file';
    if (['text', 'txt', 'plain'].includes(h)) return 'text';
    if (['mixed', 'multi', 'parts'].includes(h)) return 'mixed';
  }
  const s = asString(text);
  if (!s.trim()) return 'text';
  if (looksLikeHtml(s)) return 'html';
  if (looksLikeJson(s)) return 'json';
  const single = s.trim();
  // 图片要先于通用文件判断，否则 /files/x.png 会被当成普通文件
  if (/^data:image\//i.test(single) || /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|avif)(?:\?\S*)?$/i.test(single)) return 'image';
  if (/^\/files\//.test(single)) return /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?\S*)?$/i.test(single) ? 'image' : 'file';
  if (/^https?:\/\/\S+$/i.test(single) && FILE_EXT_HINT.test(single)) return 'file';
  if (looksLikeMarkdown(s)) return 'markdown';
  return 'text';
}

export const RESULT_TYPES = ['text', 'html', 'markdown', 'json', 'code', 'image', 'file', 'mixed', 'error'];

/** 从提示词/结果里取一行合适的标题 */
export function deriveTitle(prompt, result) {
  const source = asString(prompt).trim() || asString(result).trim();
  if (!source) return '';
  const firstLine = source.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  const cleaned = firstLine.replace(/^#+\s*/, '').replace(/^[-*>]\s*/, '').trim();
  return truncate(cleaned, 80);
}
