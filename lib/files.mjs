// 附件 / 文件落盘与读取。
// 附件统一放在 <dataDir>/files/，通过 /files/<文件名> 对外提供。

import fs from 'node:fs';
import path from 'node:path';
import { newId, randomToken, asString } from './util.mjs';

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'text/csv': '.csv',
};

export const IMAGE_MIME = /^image\//i;

export function guessMime(name, fallback = 'application/octet-stream') {
  const ext = path.extname(asString(name)).toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

export function extFromMime(mime) {
  const key = asString(mime).split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[key] || '';
}

export function isImageMime(mime, name) {
  if (IMAGE_MIME.test(asString(mime))) return true;
  const guessed = guessMime(name || '', '');
  return IMAGE_MIME.test(guessed);
}

/** 文件名安全化：保留中英文数字与 . - _ */
export function safeName(name) {
  const base = path.basename(asString(name) || 'file').replace(/[\\/:*?"<>|\s]+/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 80);
  return trimmed || 'file';
}

/** 解析 data URL：data:image/png;base64,xxxx */
export function parseDataUrl(value) {
  const s = asString(value);
  const match = /^data:([^;,]*)((?:;[^,]*)*),(.*)$/s.exec(s);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const meta = match[2] || '';
  const payload = match[3] || '';
  try {
    if (/;base64/i.test(meta)) {
      return { mime, buffer: Buffer.from(payload.replace(/\s+/g, ''), 'base64') };
    }
    return { mime, buffer: Buffer.from(decodeURIComponent(payload), 'utf8') };
  } catch {
    return null;
  }
}

/** 把 buffer 写入 <dataDir>/files，返回附件描述对象 */
export function saveFile(dataDir, { name, mime, buffer }) {
  const dir = path.join(dataDir, 'files');
  fs.mkdirSync(dir, { recursive: true });
  const clean = safeName(name);
  const ext = path.extname(clean) || extFromMime(mime);
  const stem = path.basename(clean, path.extname(clean)) || 'file';
  const stored = `${Date.now().toString(36)}-${randomToken(6)}-${stem}${ext}`;
  fs.writeFileSync(path.join(dir, stored), buffer);
  return {
    id: newId('att'),
    kind: isImageMime(mime, clean) ? 'image' : 'file',
    name: clean,
    mime: mime || guessMime(clean),
    size: buffer.length,
    path: `files/${stored}`,
    url: `/files/${encodeURIComponent(stored)}`,
    remote: false,
    created_at: new Date().toISOString(),
  };
}

/** 解析附件路径，防止目录穿越 */
export function resolveDataFile(dataDir, relPath) {
  const root = path.resolve(dataDir);
  const cleanRel = asString(relPath).replace(/^\/+/, '').replace(/^files\//, '');
  if (!cleanRel || cleanRel.includes('\0')) return null;
  const target = path.resolve(root, 'files', cleanRel);
  if (!target.startsWith(path.resolve(root, 'files') + path.sep)) return null;
  return target;
}

/** 删除 data/files 下的一个附件文件；路径非法或文件不存在都返回 false */
export function removeFileByRelativePath(dataDir, relPath) {
  const target = resolveDataFile(dataDir, relPath);
  if (!target) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}
