/* ==========================================================================
 * 模型测试记录台 · 前端逻辑（原生 JS，无构建步骤）
 * ========================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (value) =>
  String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

const TYPES = [
  { id: 'text', label: '文本' },
  { id: 'html', label: 'HTML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'json', label: 'JSON' },
  { id: 'code', label: '代码' },
  { id: 'image', label: '图片' },
  { id: 'file', label: '文件' },
  { id: 'mixed', label: '多段' },
  { id: 'error', label: '错误' },
];

const STATUSES = [
  { id: 'ok', label: '成功' },
  { id: 'error', label: '失败' },
  { id: 'pending', label: '等待' },
  { id: 'running', label: '进行中' },
  { id: 'skipped', label: '跳过' },
];

const RANGES = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: '7d', label: '近 7 天' },
  { id: '30d', label: '近 30 天' },
];

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const HARNESSES = ['codex', 'claude-code', 'cursor', 'openai-api'];

const state = {
  view: 'list',
  records: [],
  total: 0,
  offset: 0,
  limit: 50,
  order: 'desc',
  density: 'comfortable',
  loading: false,
  filters: {
    q: '',
    models: [],
    tags: [],
    types: [],
    status: [],
    reasoning_efforts: [],
    harnesses: [],
    batch_id: '',
    range: 'all',
  },
  facets: { models: [], tags: [], types: [], statuses: [], reasoning_efforts: [], harnesses: [], batches: [] },
  stats: null,
  compare: [],
  ui: {}, // recordId -> { mode, promptOpen, full }
};

const frames = new Map();
let frameSeq = 0;

// 界面图标：统一 24 网格、1.8 描边
const ICON_PATHS = {
  expand: 'm7 15 5 5 5-5M7 9l5-5 5 5',
  collapse: 'm7 20 5-5 5 5M7 4l5 5 5-5',
  shield: 'M12 21.5s7.5-3.6 7.5-9.4V5.6L12 2.8 4.5 5.6v6.5c0 5.8 7.5 9.4 7.5 9.4z',
  reload: 'M20.5 12a8.5 8.5 0 1 1-2.5-6l2.5 2.5M20.5 3.5v5h-5',
  external: 'M14 3.5h6.5V10M10.5 13.5l10-10M19 14v5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 19V7a1.5 1.5 0 0 1 1.5-1.5h5',
  download: 'M12 3.5v12m0 0-5-5m5 5 5-5M4.5 20.5h15',
  file: 'M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8zM14 3.5V8h4.5',
  close: 'M6 6l12 12M18 6 6 18',
  prev: 'm14.5 18-6-6 6-6',
  next: 'm9.5 18 6-6-6-6',
  chevron: 'm6.5 9.5 5.5 5.5 5.5-5.5',
  'zoom-in': 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9M10.5 7.8v5.4M7.8 10.5h5.4',
  'zoom-out': 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.9-4.9M7.8 10.5h5.4',
};

function icon(name, size = 14) {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON_PATHS[name] || ''}"/></svg>`;
}

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtAbs(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtShort(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRel(ms) {
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return `未来 ${fmtShort(ms)}`;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function dayLabel(key) {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);
  const d = new Date(`${key}T00:00:00`);
  const suffix = `${key} ${WEEKDAYS[d.getDay()] || ''}`;
  if (key === today) return `今天 · ${suffix}`;
  if (key === yesterday) return `昨天 · ${suffix}`;
  return suffix;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN');
}

function rangeFrom(range) {
  if (range === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range === '7d') return Date.now() - 7 * 86400000;
  if (range === '30d') return Date.now() - 30 * 86400000;
  return null;
}

function typeLabel(id) {
  const found = TYPES.find((t) => t.id === id);
  return found ? found.label : id || '文本';
}

function statusLabel(id) {
  const found = STATUSES.find((s) => s.id === id);
  return found ? found.label : id || '成功';
}

function toast(message, kind = '') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms ease';
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 5200 : 2600);
}

async function copyText(text) {
  const value = String(text ?? '');
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制到剪贴板', 'ok');
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择', ok ? 'ok' : 'error');
    return ok;
  }
}

function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

const api = {
  async request(path, options = {}) {
    const res = await fetch(path, {
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { ok: false, error: text };
    }
    if (!res.ok) throw new Error((data && data.error) || `请求失败 ${res.status}`);
    return data;
  },
  get(path) {
    return api.request(path);
  },
  post(path, body) {
    return api.request(path, { method: 'POST', body: JSON.stringify(body) });
  },
  patch(path, body) {
    return api.request(path, { method: 'PATCH', body: JSON.stringify(body) });
  },
  del(path) {
    return api.request(path, { method: 'DELETE' });
  },
};

/* ------------------------------------------------------------------ *
 * Markdown 渲染（内置极简实现，够用且无依赖）
 * ------------------------------------------------------------------ */

function inlineMd(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function mdToHtml(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    blocks.push(`<p>${inlineMd(para.join('\n')).replace(/\n/g, '<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      flush();
      i += 1;
      continue;
    }

    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1][0].repeat(3);
      const lang = fence[2] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*\\${marker[0]}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        `<pre class="md-code">${lang ? `<span class="md-lang">${esc(lang)}</span>` : ''}<code>${esc(buf.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''));
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</${tag}>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flush();
      const head = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push(
        `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }

    para.push(line);
    i += 1;
  }

  flush();
  return blocks.join('\n');
}

/* ------------------------------------------------------------------ *
 * 结果渲染
 * ------------------------------------------------------------------ */

/**
 * 注入结果 iframe 的量高脚本，以源码形式塞进 srcdoc，必须自包含、只用老语法。
 * 报告的是内容的「自然高度」：普通文档就是滚动高度；铺满视口的作品
 * （html,body{height:100%} / min-height:100vh + 居中）则量真实内容的外框，
 * 否则 iframe 多高、内容就多高，永远量不到原图尺寸。
 */
function frameProbe(key) {
  var SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TITLE: 1, TEMPLATE: 1, NOSCRIPT: 1, BR: 1 };
  var last = -1;
  var timer = 0;
  // 认定过是「内容」的元素不再被当成撑满视口的容器：iframe 收紧到内容高度后，
  // 内容本身的高度恰好等于视口，不能因此把它跳过
  var content = window.WeakSet ? new WeakSet() : null;

  function px(value) {
    return parseFloat(value) || 0;
  }

  function edge(style, side) {
    return px(style['margin' + side]) + px(style['border' + side + 'Width']) + px(style['padding' + side]);
  }

  // 收集内容外框：被视口撑满的容器只往里看、不算进外框；裁剪了溢出的容器不再往里看
  function walk(el, box, size) {
    for (var child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (SKIP[child.tagName]) continue;
      var style = getComputedStyle(child);
      if (style.display === 'none' || style.position === 'fixed') continue;
      var rect = child.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        walk(child, box, size);
        continue;
      }
      var top = rect.top;
      var bottom = rect.bottom;
      var isSvg = child.tagName.toLowerCase() === 'svg';
      var vb = isSvg && child.viewBox && child.viewBox.baseVal;
      var shaped = !!(vb && vb.width > 0 && vb.height > 0 && !/none/.test(child.getAttribute('preserveAspectRatio') || ''));
      if (shaped) {
        // 带 viewBox 的 SVG 按宽度和画布比例算应有的高度，不跟着容器高度走
        var natural = (rect.width * vb.height) / vb.width;
        top = rect.top + Math.max(0, (rect.height - natural) / 2);
        bottom = top + natural;
      }
      var stretched =
        !(content && content.has(child)) &&
        (Math.abs(rect.height - size.viewport) < 1.5 || Math.abs(rect.height - size.inner) < 1.5);
      if (!stretched && content) content.add(child);
      if ((shaped || !stretched) && style.visibility !== 'hidden') {
        if (top < box.top) box.top = top;
        if (bottom > box.bottom) box.bottom = bottom;
      }
      if (!isSvg && (stretched || style.overflowY === 'visible')) walk(child, box, size);
    }
  }

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    if (!body) return 0;
    var viewport = window.innerHeight;
    var scrollHeight = Math.max(doc.scrollHeight, body.scrollHeight);
    var htmlStyle = getComputedStyle(doc);
    var bodyStyle = getComputedStyle(body);
    var bodyRect = body.getBoundingClientRect();
    var padTop = edge(htmlStyle, 'Top') + edge(bodyStyle, 'Top');
    var padBottom = edge(htmlStyle, 'Bottom') + edge(bodyStyle, 'Bottom');
    // body 被视口撑满（height:100% / min-height:100vh 之类）。content-box 下带 padding 的 body
    // 会比视口高出一截，也算撑满，否则每次按滚动高度放大都会再多出一截 padding，越量越高
    var bodyInner = bodyRect.height - edge(bodyStyle, 'Top') - edge(bodyStyle, 'Bottom') + px(bodyStyle.marginTop) + px(bodyStyle.marginBottom);
    var filling =
      Math.abs(bodyRect.height + px(bodyStyle.marginTop) + px(bodyStyle.marginBottom) - viewport) < 1.5 ||
      Math.abs(bodyRect.height - viewport) < 1.5 ||
      Math.abs(bodyInner - viewport) < 1.5;
    // 普通的长文档：滚动高度就是自然高度
    if (!filling && scrollHeight > viewport + 1) return scrollHeight;

    var box = { top: Infinity, bottom: -Infinity };
    walk(body, box, { viewport: viewport, inner: viewport - padTop - padBottom });
    var scrollY = window.scrollY || 0;
    if (!filling) {
      var flowBottom = bodyRect.bottom + scrollY + px(bodyStyle.marginBottom);
      return box.bottom > -Infinity ? Math.max(flowBottom, box.bottom + scrollY) : flowBottom;
    }
    // 内容完全跟着视口走（全屏 canvas 之类）：没有「原图」可言，保持当前高度
    if (box.bottom === -Infinity) return viewport;
    var above = box.top + scrollY - padTop;
    var below = viewport - padBottom - (box.bottom + scrollY);
    // 被裁掉就补回来；有空余就收紧（居中布局上下各收一份，顶部对齐时多收的下一轮会补回）
    if (above < -0.5 || below < -0.5) return viewport + Math.max(0, -above) + Math.max(0, -below);
    return viewport - below - Math.min(above, below);
  }

  function report() {
    timer = 0;
    var height;
    try {
      height = Math.ceil(measure());
    } catch (e) {
      return;
    }
    if (!height || height === last) return;
    last = height;
    parent.postMessage({ __mtlHeight: 1, id: key, h: height }, '*');
  }

  // 沙箱 iframe 是跨源的，离屏时 rAF 可能被暂停，所以用定时器合并多次触发
  function schedule() {
    if (!timer) timer = setTimeout(report, 16);
  }

  if (document.readyState !== 'loading') schedule();
  else document.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('load', schedule, true);
  [80, 400, 1200, 2500].forEach(function (ms) {
    setTimeout(schedule, ms);
  });
  try {
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    if (window.ResizeObserver) {
      var observer = new ResizeObserver(schedule);
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
    }
  } catch (e) {
    /* 老浏览器靠定时器兜底 */
  }
}

function frameSrcdoc(html, key) {
  const probe = '<scr' + 'ipt>(' + frameProbe.toString() + ')(' + JSON.stringify(key) + ');</scr' + 'ipt>';
  const source = String(html ?? '');
  if (/<\/body\s*>/i.test(source)) return source.replace(/<\/body\s*>/i, () => `${probe}</body>`);
  if (/<html[\s>]/i.test(source)) return source + probe;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:0;font:14px/1.6 Inter,system-ui,-apple-system,"PingFang SC",sans-serif}img{max-width:100%}</style></head><body>${source}${probe}</body></html>`;
}

function frameDoc(key) {
  const entry = frames.get(key);
  return entry ? entry.doc : '';
}

// HTML 源码 -> 上次量到的自然高度。重渲染时先按它占位，避免高度从默认值跳过去
const frameHeights = new Map();
const FRAME_MIN = 80;
const FRAME_MAX = 40000;
// 折叠态只比上限高出一点时不裁，免得为几十像素多点一次
const FRAME_CAP_SLACK = 48;

function frameCap(wrap) {
  const value = wrap ? parseFloat(getComputedStyle(wrap).getPropertyValue('--frame-cap')) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 560;
}

function renderHtmlFrame(record, content, { full = false, key = null, note = true, collapsible = true } = {}) {
  const frameKey = key || `frame-${++frameSeq}`;
  const source = String(content ?? '');
  frames.set(frameKey, { doc: frameSrcdoc(source, frameKey), source });
  const cached = frameHeights.get(source);
  const expanded = full || !collapsible;
  const classes = ['frame-wrap', collapsible && 'collapsible', expanded && 'expanded', !note && 'is-draft'].filter(Boolean).join(' ');
  return `
    <div class="${classes}"${cached ? ` style="--frame-h:${cached}px"` : ''}>
      <div class="frame-viewport">
        <iframe class="result-frame" data-frame="${frameKey}"${cached ? ` style="height:${cached}px"` : ''} sandbox="allow-scripts allow-popups allow-forms allow-modals" title="结果预览"></iframe>
        ${
          collapsible
            ? `<div class="frame-fade"><button type="button" class="frame-more" data-act="frame-full">${icon('expand')}<span>展开完整高度</span></button></div>`
            : ''
        }
      </div>
      ${
        note
          ? `<div class="frame-bar">
        <span class="frame-bar-info" title="在沙箱 iframe 内渲染：脚本可运行，但与记录台页面隔离">${icon('shield')}<span>沙箱渲染</span><span class="frame-size" data-frame-size></span></span>
        <span class="spacer"></span>
        ${
          collapsible
            ? `<button type="button" class="frame-tool frame-toggle" data-act="frame-full">${icon(expanded ? 'collapse' : 'expand')}<span>${expanded ? '收起' : '展开全部'}</span></button>`
            : ''
        }
        <button type="button" class="frame-tool" data-act="frame-reload" data-frame="${frameKey}">${icon('reload')}<span>重载</span></button>
        ${record ? `<a class="frame-tool" href="/r/${encodeURIComponent(record.id)}" target="_blank" rel="noopener">${icon('external')}<span>新窗口</span></a>` : ''}
      </div>`
          : ''
      }
    </div>`;
}

/** 用 src 直接挂一个 HTML 文件（沙箱里量不到跨文档高度，给固定高度） */
function renderHtmlFrameSrc(url, label) {
  const name = label || basenameOf(url);
  return `
    <div class="frame-wrap expanded">
      <div class="frame-viewport">
        <iframe class="result-frame external" src="${esc(url)}" sandbox="allow-scripts allow-popups allow-forms allow-modals" title="${esc(name)}"></iframe>
      </div>
      <div class="frame-bar">
        <span class="frame-bar-info">${icon('file')}<span>${esc(name)}</span></span>
        <span class="spacer"></span>
        <a class="frame-tool" href="${esc(url)}" target="_blank" rel="noopener">${icon('external')}<span>新窗口</span></a>
        <a class="frame-tool" href="${esc(url)}" download>${icon('download')}<span>下载</span></a>
      </div>
    </div>`;
}

function renderPart(record, part, opts) {
  const type = part.type || 'text';
  const content = part.content || '';
  if (type === 'html') return renderHtmlFrame(record, content, opts);
  if (type === 'markdown') return `<div class="markdown">${mdToHtml(content)}</div>`;
  if (type === 'json') return `<pre class="code-block">${esc(content)}</pre>`;
  if (type === 'code') return `<pre class="code-block">${esc(content)}</pre>`;
  if (type === 'image') return imageGridHtml([content]);
  if (type === 'file') {
    // 文件型结果如果本身是 HTML，直接渲染出来，而不是给一张下载卡
    if (/\.html?($|\?)/i.test(String(content))) return renderHtmlFrameSrc(content, basenameOf(content));
    return fileCardHtml(content, findAttachment(record, content));
  }
  if (type === 'error') return `<div class="error-block">${esc(content)}</div>`;
  return `<pre class="text-block">${esc(content)}</pre>`;
}

/** 记录里挂着 HTML 附件但结果为空时，把附件渲染出来（历史数据的兜底） */
function htmlAttachmentOf(record) {
  const list = (record && record.attachments) || [];
  return list.find((att) => att && (/\.html?($|\?)/i.test(att.url || '') || /text\/html/i.test(att.mime || ''))) || null;
}

function basenameOf(url) {
  const clean = String(url || '').split(/[?#]/)[0];
  const last = clean.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function findAttachment(record, url) {
  if (!record || !Array.isArray(record.attachments)) return null;
  return record.attachments.find((att) => att && att.url === url) || null;
}

/** 结果正文为空、只挂了图片附件（常见于生图模型）时，这些图片就是结果 */
function resultImagesOf(record) {
  if (!record || record.result || (Array.isArray(record.parts) && record.parts.length) || htmlAttachmentOf(record)) return [];
  return (record.attachments || []).filter((att) => att && att.kind === 'image');
}

function imageGridHtml(urls, names = []) {
  return `<div class="image-grid ${urls.length === 1 ? 'single' : ''}">${urls
    .map((url, index) => {
      const name = names[index] || basenameOf(url) || '结果图片';
      return `<a class="image-item" href="${esc(url)}" data-act="lightbox" data-url="${esc(url)}" data-name="${esc(name)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy"></a>`;
    })
    .join('')}</div>`;
}

/** 文件型结果：能预览的就地预览，不能预览的给「打开 / 下载」 */
function fileCardHtml(url, meta) {
  const value = String(url || '').trim();
  if (!value) return '<div class="muted-block">（没有文件）</div>';
  const name = (meta && meta.name) || basenameOf(value) || value;
  const mime = (meta && meta.mime) || '';
  const size = meta && Number.isFinite(meta.size) ? fmtBytes(meta.size) : '';
  const lower = value.toLowerCase();
  const isImage = (meta && meta.kind === 'image') || /\.(png|jpe?g|gif|webp|svg|bmp|avif)($|\?)/.test(lower) || /^data:image\//.test(lower);

  let preview = '';
  if (isImage) {
    preview = `<div class="file-preview"><a href="${esc(value)}" data-act="lightbox" data-url="${esc(value)}" data-name="${esc(name)}" target="_blank" rel="noopener"><img src="${esc(value)}" alt="${esc(name)}" loading="lazy"></a></div>`;
  } else if (/\.pdf($|\?)/.test(lower)) {
    preview = `<iframe class="file-frame" src="${esc(value)}" title="${esc(name)}" loading="lazy"></iframe>`;
  } else if (/\.(mp4|webm|mov)($|\?)/.test(lower)) {
    preview = `<video class="file-video" controls src="${esc(value)}"></video>`;
  } else if (/\.(mp3|wav|ogg|flac)($|\?)/.test(lower)) {
    preview = `<audio controls src="${esc(value)}"></audio>`;
  }

  return `<div class="file-card">
    <div class="file-card-head">
      <span class="file-icon">${esc(fileExt(name))}</span>
      <span class="file-meta">
        <strong>${esc(name)}</strong>
        <span>${esc(mime)}${mime && size ? ' · ' : ''}${esc(size)}</span>
      </span>
      <span class="spacer"></span>
      <a class="ghost-button" href="${esc(value)}" target="_blank" rel="noopener">新窗口打开</a>
      <a class="ghost-button" href="${esc(value)}" download>下载</a>
    </div>
    ${preview}
  </div>`;
}

function renderResultBody(record, opts = {}) {
  const ui = state.ui[record.id] || {};
  const mode = opts.mode || ui.mode || 'preview';

  if (record.status === 'error' && record.error && !record.result) {
    return `<div class="error-block">${esc(record.error)}</div>`;
  }

  const parts = Array.isArray(record.parts) && record.parts.length ? record.parts : null;

  if (parts) {
    if (parts.length === 1) return renderPart(record, parts[0], opts);
    return `<div class="parts">${parts
      .map(
        (part, index) => `
        <div class="part">
          <div class="part-head">${esc(part.label || typeLabel(part.type))} · ${index + 1}/${parts.length}</div>
          ${renderPart(record, part, opts)}
        </div>`,
      )
      .join('')}</div>`;
  }

  if (!record.result) {
    const htmlAtt = htmlAttachmentOf(record);
    if (htmlAtt) return renderHtmlFrameSrc(htmlAtt.url, htmlAtt.name);
    const images = resultImagesOf(record);
    if (images.length) return imageGridHtml(images.map((att) => att.url), images.map((att) => att.name));
    return '<div class="muted-block">（没有结果内容）</div>';
  }

  if (record.result_type === 'html') {
    if (mode === 'source') return `<pre class="code-block">${esc(record.result)}</pre>`;
    return renderHtmlFrame(record, record.result, opts);
  }
  return renderPart(record, { type: record.result_type, content: record.result }, opts);
}

/** 插入 DOM 后再把 srcdoc 写进 iframe，避免属性转义问题 */
let frameObserver = null;

/** 还没量到高度前的占位：按常见窗口比例给，铺满视口的作品也会以这个比例为基准排版 */
function initialFrameHeight(frame) {
  const width = frame.clientWidth || (frame.parentElement && frame.parentElement.clientWidth) || 960;
  return Math.round(Math.min(720, Math.max(360, width * 0.5625)));
}

function loadFrame(frame) {
  const key = frame.getAttribute('data-frame');
  if (!key || !frames.has(key)) return;
  const wrap = frame.closest('.frame-wrap');
  wrap?.classList.add('is-loading');
  frame.addEventListener(
    'load',
    () => {
      wrap?.classList.remove('is-loading');
    },
    { once: true },
  );
  frame._mtlFrozen = false;
  frame._mtlResizes = [];
  frame.setAttribute('srcdoc', frameDoc(key));
  frame.removeAttribute('data-lazy');
  if (frameObserver) frameObserver.unobserve(frame);
}

function hydrateFrames(root = document) {
  const candidates = $$('iframe[data-frame]', root).filter((frame) => frame.getAttribute('srcdoc') === null);
  if (!candidates.length) return;
  candidates.forEach((frame) => {
    if (!frame.style.height) syncFrameHeight(frame, initialFrameHeight(frame));
  });
  if (!('IntersectionObserver' in window)) {
    candidates.forEach(loadFrame);
    return;
  }
  if (!frameObserver) {
    frameObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) loadFrame(entry.target);
        });
      },
      { rootMargin: '480px 0px' },
    );
  }
  candidates.forEach((frame) => {
    frame.dataset.lazy = '1';
    frameObserver.observe(frame);
  });
}

/** iframe 始终按自然高度排版；折叠只是外层视口裁掉下半截，所以两种状态看到的都是原图 */
function syncFrameHeight(frame, height, measured = false) {
  frame.style.height = `${height}px`;
  const wrap = frame.closest('.frame-wrap');
  if (!wrap) return;
  wrap.style.setProperty('--frame-h', `${height}px`);
  wrap.classList.toggle('is-tall', wrap.classList.contains('collapsible') && height > frameCap(wrap) + FRAME_CAP_SLACK);
  const size = wrap.querySelector('[data-frame-size]');
  if (size && measured) size.textContent = `高 ${fmtNum(height)} px`;
}

function refreshFrameCaps(root = document) {
  $$('.frame-wrap.collapsible', root).forEach((wrap) => {
    const frame = wrap.querySelector('iframe[data-frame]');
    const height = frame && parseFloat(frame.style.height);
    if (height) syncFrameHeight(frame, height);
  });
}

function setFrameExpanded(wrap, expanded) {
  wrap.classList.toggle('expanded', expanded);
  const toggle = wrap.querySelector('.frame-toggle');
  if (toggle) toggle.innerHTML = `${icon(expanded ? 'collapse' : 'expand')}<span>${expanded ? '收起' : '展开全部'}</span>`;
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || !data.__mtlHeight) return;
  const frame = $$('iframe[data-frame]').find((item) => item.dataset.frame === String(data.id));
  if (!frame || (event.source && event.source !== frame.contentWindow)) return;
  const height = Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, Number(data.h) || 0)));
  const current = parseFloat(frame.style.height) || 0;
  if (Math.abs(height - current) < 2) {
    syncFrameHeight(frame, current, true);
    return;
  }
  // 高度和视口互相牵连的作品（比如 height: 80vh）会越量越偏；短时间内调整过多就停在当前高度
  if (frame._mtlFrozen) return;
  const now = Date.now();
  frame._mtlResizes = (frame._mtlResizes || []).filter((time) => now - time < 2000);
  frame._mtlResizes.push(now);
  if (frame._mtlResizes.length > 24) {
    frame._mtlFrozen = true;
    return;
  }
  const entry = frames.get(frame.dataset.frame);
  if (entry) frameHeights.set(entry.source, height);
  syncFrameHeight(frame, height, true);
});

/* ------------------------------------------------------------------ *
 * 记录卡片
 * ------------------------------------------------------------------ */

function recordUi(id) {
  if (!state.ui[id]) state.ui[id] = { mode: 'preview', promptOpen: false, full: false };
  return state.ui[id];
}

function statusBadge(record) {
  const status = record.status || 'ok';
  return `<span class="badge status ${esc(status)}">${esc(statusLabel(status))}</span>`;
}

function tagBadges(record) {
  return (record.tags || [])
    .map((tag) => `<button class="badge tag" type="button" data-act="filter-tag" data-tag="${esc(tag)}">#${esc(tag)}</button>`)
    .join('');
}

function attachmentStripItem(att) {
  if (!att) return '';
  const title = `${att.name}（${fmtBytes(att.size)}）`;
  if (att.kind === 'image') {
    return `<a class="thumb" href="${esc(att.url)}" data-act="lightbox" data-url="${esc(att.url)}" data-name="${esc(att.name)}" target="_blank" rel="noopener" title="${esc(title)}"><img src="${esc(att.url)}" alt="${esc(att.name)}" loading="lazy"></a>`;
  }
  return `<a class="file-chip" href="${esc(att.url)}" target="_blank" rel="noopener" title="${esc(title)}"><span class="file-chip-ext">${esc(fileExt(att.name))}</span><span class="file-chip-name">${esc(att.name)}</span><span class="file-chip-size">${fmtBytes(att.size)}</span></a>`;
}

/** 卡片底部的附件缩略图；已经被当作结果展示的文件不再重复出现 */
function attachmentStripHtml(record) {
  const shown = new Set(resultImagesOf(record).map((att) => att.url));
  const list = (record.attachments || []).filter((att) => att && att.url !== record.result && !shown.has(att.url));
  if (!list.length) return '';
  return `<div class="attachment-strip">${list.map(attachmentStripItem).join('')}</div>`;
}

/** 转义后把网址变成可点的链接 */
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

/** HTML 结果的「预览 / 源码」切换 */
function modeSwitchHtml(mode) {
  return `<div class="segmented" role="group" aria-label="结果显示方式">
    <button type="button" class="${mode !== 'source' ? 'active' : ''}" data-act="mode" data-mode="preview" aria-pressed="${mode !== 'source'}">预览</button>
    <button type="button" class="${mode === 'source' ? 'active' : ''}" data-act="mode" data-mode="source" aria-pressed="${mode === 'source'}">源码</button>
  </div>`;
}

function renderRecordCard(record, { detail = false } = {}) {
  const ui = recordUi(record.id);
  const picked = state.compare.includes(record.id);
  const prompt = record.prompt || '';
  const promptLong = prompt.length > 260 || prompt.split('\n').length > 4;
  const promptOpen = ui.promptOpen || detail;

  const subBits = [`<span title="记录时间 ${esc(fmtAbs(record.created_at_ms))}">${esc(fmtAbs(record.created_at_ms))}</span>`, `<span>${esc(fmtRel(record.created_at_ms))}</span>`];
  if (record.latency_ms !== null && record.latency_ms !== undefined) subBits.push(`<span>耗时 ${fmtNum(record.latency_ms)} ms</span>`);
  if (record.total_tokens) subBits.push(`<span>${fmtNum(record.total_tokens)} tokens</span>`);
  if (record.cost !== null && record.cost !== undefined && record.cost !== '') subBits.push(`<span>成本 ${esc(record.cost)} ${esc(record.currency || '')}</span>`);
  if (record.provider) subBits.push(`<span>渠道 ${esc(record.provider)}</span>`);
  if (record.source && record.source !== 'api') subBits.push(`<span>来源 ${esc(record.source)}</span>`);
  const note = record.meta && record.meta.note ? String(record.meta.note) : '';

  const facts = [];
  if (record.model) facts.push(`<span class="record-fact model"><span>模型</span><strong>${esc(record.model)}</strong></span>`);
  if (record.reasoning_effort) {
    facts.push(`<span class="record-fact"><span>思考</span><strong>${esc(record.reasoning_effort)}</strong></span>`);
  }
  if (record.harness) facts.push(`<span class="record-fact"><span>Harness</span><strong>${esc(record.harness)}</strong></span>`);
  if (record.batch_name) facts.push(`<span class="record-fact"><span>批次</span><strong>${esc(record.batch_name)}</strong></span>`);
  const tags = record.tags && record.tags.length ? `<span class="record-tags">${tagBadges(record)}</span>` : '';

  const isHtml = record.result_type === 'html' && !(record.parts && record.parts.length > 1) && !!record.result;

  return `
  <article class="record-card ${picked ? 'picked' : ''}" data-id="${esc(record.id)}">
    <header class="record-head">
      <label class="checkbox" title="加入对比">
        <input type="checkbox" class="pick-box" data-act="pick" aria-label="加入对比" ${picked ? 'checked' : ''}>
      </label>
      <div class="record-title-wrap">
        <h3 class="record-title">${esc(record.title || '(无标题)')}</h3>
        <div class="record-sub">${subBits.join('<span class="dot"></span>')}</div>
      </div>
      <div class="record-head-right">${statusBadge(record)}</div>
    </header>

    ${facts.length || tags ? `<div class="record-facts">${facts.join('')}${tags}</div>` : ''}

    ${
      prompt
        ? `<section class="block prompt-block">
            <div class="block-head">
              <span class="label">提示词</span>
              <span class="spacer"></span>
              ${
                promptLong && !detail
                  ? `<button type="button" class="text-toggle ${promptOpen ? 'open' : ''}" data-act="toggle-prompt" aria-expanded="${promptOpen}"><span>${promptOpen ? '收起' : '展开'}</span>${icon('chevron', 13)}</button>`
                  : ''
              }
            </div>
            <div class="prompt-text ${promptOpen || !promptLong ? '' : 'clamp'}">${esc(prompt)}</div>
          </section>`
        : ''
    }

    <section class="block result-block">
      <div class="block-head">
        <span class="label">结果</span>
        <span class="type-chip">${esc(typeLabel(record.result_type))}</span>
        <span class="spacer"></span>
        <div class="block-actions">${isHtml ? modeSwitchHtml(ui.mode) : ''}</div>
      </div>
      <div class="result-body">${renderResultBody(record, { full: ui.full })}</div>
    </section>

    ${attachmentStripHtml(record)}

    ${record.error && record.result ? `<div class="error-block" style="margin-top:10px">${esc(record.error)}</div>` : ''}
    ${note ? `<div class="record-note"><span class="record-note-label">备注</span><span class="record-note-text">${linkify(note)}</span></div>` : ''}

    <footer class="record-actions">
      <div class="record-actions-main">
        <button type="button" class="ghost-button strong" data-act="detail">查看详情</button>
        <button type="button" class="ghost-button" data-act="copy">复制结果</button>
        <button type="button" class="ghost-button" data-act="download">下载</button>
      </div>
      <details class="more-menu">
        <summary class="ghost-button">更多</summary>
        <div class="more-menu-panel">
          <span class="more-menu-id">ID · ${esc(record.id)}</span>
          <button class="menu-item" data-act="edit">编辑记录</button>
          <button class="menu-item" data-act="copy-json">复制 JSON</button>
          <a class="menu-item" href="/r/${encodeURIComponent(record.id)}" target="_blank" rel="noopener">打开结果页</a>
          <span class="menu-separator"></span>
          <button class="menu-item danger" data-act="delete">删除记录</button>
        </div>
      </details>
    </footer>
  </article>`;
}

function activeFilterChip(kind, value, label) {
  return `<button class="active-filter-chip" type="button" data-act="remove-filter" data-kind="${esc(kind)}" data-value="${esc(value)}">
    <span>${esc(label)}</span><span class="active-filter-remove" aria-hidden="true">×</span>
  </button>`;
}

function activeFiltersHtml() {
  const f = state.filters;
  const chips = [];
  f.models.forEach((value) => chips.push(activeFilterChip('model', value, `模型 · ${value}`)));
  f.tags.forEach((value) => chips.push(activeFilterChip('tag', value, `#${value}`)));
  f.types.forEach((value) => chips.push(activeFilterChip('type', value, `类型 · ${typeLabel(value)}`)));
  f.status.forEach((value) => chips.push(activeFilterChip('status', value, `状态 · ${statusLabel(value)}`)));
  f.reasoning_efforts.forEach((value) => chips.push(activeFilterChip('reasoning', value, `思考 · ${value}`)));
  f.harnesses.forEach((value) => chips.push(activeFilterChip('harness', value, `Harness · ${value}`)));
  if (f.batch_id) {
    const batch = state.facets.batches.find((item) => item.id === f.batch_id);
    chips.push(activeFilterChip('batch', f.batch_id, `批次 · ${batch ? batch.name : f.batch_id}`));
  }
  if (f.range !== 'all') {
    const range = RANGES.find((item) => item.id === f.range);
    chips.push(activeFilterChip('range', f.range, range ? range.label : f.range));
  }
  if (!chips.length) return '';
  return `<div class="active-filters">${chips.join('')}<button class="link-button" type="button" data-act="clear-filters">清空筛选</button></div>`;
}

/* ------------------------------------------------------------------ *
 * 列表视图
 * ------------------------------------------------------------------ */

function emptyState() {
  const base = location.origin;
  return `
  <div class="empty-state">
    <h3>还没有记录</h3>
    <p>按下方的接口登记一条，或用左下角的「新建记录」手动填写。刷新页面即可看到。</p>
    <div class="code-card" style="max-width:720px;text-align:left;margin-top:8px">
      <div class="code-head"><span>curl</span><span class="spacer"></span><button class="ghost-button" data-act="copy-code">复制</button></div>
      <pre>curl -X POST ${esc(base)}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{"model":"gpt-5.1","prompt":"你好","result":"你好，有什么可以帮你？","latency_ms":820}'</pre>
    </div>
  </div>`;
}

function renderList() {
  const content = $('#content');
  frames.clear();
  if (state.loading && !state.records.length) {
    content.innerHTML = '<div class="loading-state">正在加载记录…</div>';
    return;
  }
  if (!state.records.length) {
    content.innerHTML = emptyState();
    return;
  }

  const groups = new Map();
  for (const record of state.records) {
    const key = dayKey(record.created_at_ms);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  const activeFilterCount =
    state.filters.models.length +
    state.filters.tags.length +
    state.filters.types.length +
    state.filters.status.length +
    state.filters.reasoning_efforts.length +
    state.filters.harnesses.length +
    (state.filters.batch_id ? 1 : 0) +
    (state.filters.range !== 'all' ? 1 : 0);
  const activeFilters = activeFiltersHtml();

  let html = `<div class="list-head">
    <div>
      <h1>全部记录</h1>
      <p>${fmtNum(state.total)} 条记录${activeFilterCount ? ` · 已启用 ${activeFilterCount} 个筛选` : ''}</p>
    </div>
    ${activeFilters}
  </div><div class="record-groups">`;
  for (const [key, items] of groups) {
    html += `<section class="day-group">
      <div class="day-label"><span>${esc(dayLabel(key))}</span><span>${items.length} 条</span></div>
      <div class="record-list">${items.map((r) => renderRecordCard(r)).join('')}</div>
    </section>`;
  }
  html += '</div>';

  if (state.records.length < state.total) {
    html += `<div class="more-row"><button class="button" data-act="load-more">加载更多（已显示 ${state.records.length} / ${state.total}）</button></div>`;
  }

  if (state.compare.length) {
    html += `<div class="bulk-bar">
      <span>已选 <b>${state.compare.length}</b> 条</span>
      <button class="button primary" data-act="goto-compare">并排对比</button>
      <button class="button" data-act="clear-compare">清空选择</button>
    </div>`;
  }

  content.innerHTML = html;
  hydrateFrames(content);
}

/* ------------------------------------------------------------------ *
 * 批次视图
 * ------------------------------------------------------------------ */

function renderBatches() {
  const content = $('#content');
  const batches = state.facets.batches || [];
  if (!batches.length) {
    content.innerHTML = `
      <div class="empty-state">
        <h3>还没有测试批次</h3>
        <p>在登记接口里带上 <code>batch</code>（或 <code>batch_name</code> / <code>group</code>）字段，就会自动建批次。</p>
        <div class="code-card" style="max-width:720px;text-align:left">
          <div class="code-head"><span>curl</span><span class="spacer"></span><button class="ghost-button" data-act="copy-code">复制</button></div>
          <pre>curl -X POST ${esc(location.origin)}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{"batch":"2026-09-17 数学推理对比","model":"gpt-5.1","prompt":"1+1=?","result":"2"}'</pre>
        </div>
      </div>`;
    return;
  }

  const rows = batches
    .map(
      (batch) => `
    <article class="record-card" data-batch="${esc(batch.id)}">
      <header class="record-head">
        <div class="record-title-wrap">
          <h3 class="record-title">${esc(batch.name)}</h3>
          <div class="record-sub">
            <span>创建于 ${esc(fmtAbs(batch.created_at_ms))}</span>
            <span class="dot"></span>
            <span>${esc(batch.id)}</span>
          </div>
        </div>
        <div class="record-head-right"><span class="badge model">${fmtNum(batch.count)} 条记录</span></div>
      </header>
      ${batch.note ? `<div class="muted-block">${esc(batch.note)}</div>` : ''}
      <footer class="record-meta" style="border-top:0;padding-top:8px">
        <button class="ghost-button" data-act="open-batch">查看记录</button>
        <button class="ghost-button" data-act="compare-batch">一键并排对比</button>
        <button class="ghost-button" data-act="rename-batch">重命名</button>
        <button class="ghost-button" data-act="delete-batch">删除批次</button>
      </footer>
    </article>`,
    )
    .join('');

  content.innerHTML = `
    <div class="page-head">
      <div>
        <h2>测试批次</h2>
        <p>同一个提示词下跑多个模型时，把它们归入同一批次，就能一键并排对比。</p>
      </div>
      <div class="actions"><button class="button" data-act="new-batch">新建批次</button></div>
    </div>
    <div class="record-list">${rows}</div>`;
}

/* ------------------------------------------------------------------ *
 * 对比视图
 * ------------------------------------------------------------------ */

function renderCompare() {
  const content = $('#content');
  frames.clear();
  const picked = state.compare.map((id) => state.records.find((r) => r.id === id)).filter(Boolean);
  if (!picked.length) {
    content.innerHTML = `
      <div class="empty-state">
        <h3>还没有选择记录</h3>
        <p>回到「全部记录」，勾选 2–4 条记录（比如同一批次下不同模型的结果），再点「并排对比」。</p>
        <button class="button primary" data-act="goto-list">去选择记录</button>
      </div>`;
    return;
  }

  const cols = Math.min(picked.length, 4);
  const cards = picked
    .map(
      (record, index) => `
    <div class="compare-col" data-id="${esc(record.id)}">
      <header>
        <span class="title" title="${esc(record.title || '')}">${esc(record.model || '(未填模型)')} · ${esc(record.title || record.id)}</span>
        <button class="icon-button" data-act="unpick" title="移出对比">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div class="compare-section">
        <h5>记录信息</h5>
        <div class="record-sub">
          <span>${esc(fmtAbs(record.created_at_ms))}</span>
          ${record.latency_ms ? `<span class="dot"></span><span>${fmtNum(record.latency_ms)} ms</span>` : ''}
          ${record.total_tokens ? `<span class="dot"></span><span>${fmtNum(record.total_tokens)} tokens</span>` : ''}
          ${record.reasoning_effort ? `<span class="dot"></span><span>思考 ${esc(record.reasoning_effort)}</span>` : ''}
          ${record.harness ? `<span class="dot"></span><span>Harness ${esc(record.harness)}</span>` : ''}
        </div>
        <div class="badge-row">${record.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}</div>
      </div>
      <div class="compare-section">
        <h5>提示词</h5>
        <div class="prompt-text">${esc(record.prompt || '（空）')}</div>
      </div>
      <div class="compare-section">
        <h5>结果 · ${esc(typeLabel(record.result_type))}</h5>
        <div class="result-body" style="padding:0">${renderResultBody(record, { mode: 'preview', full: recordUi(record.id).full })}</div>
        <div class="badge-row">
          <button class="ghost-button" data-act="copy">复制</button>
          <a class="ghost-button" href="/r/${encodeURIComponent(record.id)}" target="_blank" rel="noopener">打开结果页</a>
        </div>
      </div>
      <div class="compare-section"><h5>操作</h5>
        <button class="ghost-button" data-act="detail">详情</button>
        <button class="ghost-button" data-act="unpick">移出对比</button>
      </div>
    </div>`,
    )
    .join('');

  content.innerHTML = `
    <div class="page-head">
      <div>
        <h2>结果对比 <span style="color:var(--subtle);font-size:13px">（${picked.length} 条）</span></h2>
        <p>同一提示词下不同模型的输出并排查看；HTML 结果会被截断到合适高度，可单独展开。</p>
      </div>
      <div class="actions">
        <button class="button" data-act="clear-compare">清空</button>
        <button class="button" data-act="goto-list">继续选择</button>
      </div>
    </div>
    <div class="compare-grid" style="--cols:${cols}">${cards}</div>`;
  hydrateFrames(content);
}

/* ------------------------------------------------------------------ *
 * 统计视图
 * ------------------------------------------------------------------ */

function renderStats() {
  const content = $('#content');
  const stats = state.stats;
  if (!stats) {
    content.innerHTML = '<div class="loading-state">正在统计…</div>';
    return;
  }

  const maxSeries = Math.max(1, ...stats.series.map((d) => d.count));
  const chart = stats.series
    .map((day) => {
      const h = Math.round((day.count / maxSeries) * 100);
      const label = day.date.slice(5);
      return `<div class="bar-col" title="${esc(day.date)}：${day.count} 条${day.errors ? `（${day.errors} 条失败）` : ''}">
        <span class="val">${day.count || ''}</span>
        <div class="bar ${day.errors ? 'has-error' : ''}" style="height:${Math.max(h, day.count ? 4 : 2)}%"></div>
        <span class="day">${esc(label)}</span>
      </div>`;
    })
    .join('');

  const maxModel = Math.max(1, ...stats.models.map((m) => m.count));
  const models = stats.models.length
    ? stats.models
        .slice(0, 12)
        .map(
          (m) => `<div class="dist-row">
        <span class="name" title="${esc(m.model)}">${esc(m.model)}</span>
        <span class="track"><span class="fill" style="width:${Math.round((m.count / maxModel) * 100)}%"></span></span>
        <span class="num">${fmtNum(m.count)}</span>
      </div>`,
        )
        .join('')
    : '<div class="facet-empty">暂无数据</div>';

  const maxType = Math.max(1, ...stats.types.map((t) => t.count));
  const types = stats.types.length
    ? stats.types
        .map(
          (t) => `<div class="dist-row">
        <span class="name">${esc(typeLabel(t.type))}</span>
        <span class="track"><span class="fill" style="width:${Math.round((t.count / maxType) * 100)}%"></span></span>
        <span class="num">${fmtNum(t.count)}</span>
      </div>`,
        )
        .join('')
    : '<div class="facet-empty">暂无数据</div>';

  const maxTag = Math.max(1, ...stats.tags.map((t) => t.count));
  const tags = stats.tags.length
    ? stats.tags
        .slice(0, 14)
        .map(
          (t) => `<div class="dist-row">
        <span class="name">#${esc(t.tag)}</span>
        <span class="track"><span class="fill" style="width:${Math.round((t.count / maxTag) * 100)}%"></span></span>
        <span class="num">${fmtNum(t.count)}</span>
      </div>`,
        )
        .join('')
    : '<div class="facet-empty">暂无数据</div>';

  const maxReasoning = Math.max(1, ...(stats.reasoning_efforts || []).map((item) => item.count));
  const reasoning = stats.reasoning_efforts?.length
    ? stats.reasoning_efforts
        .map(
          (item) => `<div class="dist-row">
        <span class="name" title="${esc(item.reasoning_effort)}">${esc(item.reasoning_effort)}</span>
        <span class="track"><span class="fill" style="width:${Math.round((item.count / maxReasoning) * 100)}%"></span></span>
        <span class="num">${fmtNum(item.count)}</span>
      </div>`,
        )
        .join('')
    : '<div class="facet-empty">暂无思考等级数据</div>';

  const maxHarness = Math.max(1, ...(stats.harnesses || []).map((item) => item.count));
  const harnesses = stats.harnesses?.length
    ? stats.harnesses
        .map(
          (item) => `<div class="dist-row">
        <span class="name" title="${esc(item.harness)}">${esc(item.harness)}</span>
        <span class="track"><span class="fill" style="width:${Math.round((item.count / maxHarness) * 100)}%"></span></span>
        <span class="num">${fmtNum(item.count)}</span>
      </div>`,
        )
        .join('')
    : '<div class="facet-empty">暂无 Harness 数据</div>';

  const avgLatency = (() => {
    const items = state.records.filter((r) => Number.isFinite(r.latency_ms));
    if (!items.length) return '—';
    return `${Math.round(items.reduce((sum, r) => sum + r.latency_ms, 0) / items.length)} ms`;
  })();

  const errors = stats.statuses.find((s) => s.status === 'error');
  const errorRate = stats.total ? `${((((errors ? errors.count : 0) ) / stats.total) * 100).toFixed(1)}%` : '0%';

  content.innerHTML = `
    <div class="page-head">
      <div>
        <h2>统计概览</h2>
        <p>数据后端：${esc(stats.backend === 'sqlite' ? 'SQLite（node:sqlite）' : 'JSON 文件（回退模式）')} · 生成于 ${esc(fmtAbs(Date.parse(stats.generated_at)))}</p>
      </div>
      <div class="actions">
        <button class="button" data-act="refresh">刷新</button>
        <a class="button" href="/api/export?format=json&download=1">导出 JSON</a>
        <a class="button" href="/api/export?format=csv&download=1">导出 CSV</a>
      </div>
    </div>

    <section class="stat-cards">
      <div class="stat-card"><span>记录总数</span><strong>${fmtNum(stats.total)}</strong><em>全部时间</em></div>
      <div class="stat-card"><span>今天</span><strong>${fmtNum(stats.today)}</strong><em>近 7 天 ${fmtNum(stats.last7)} 条</em></div>
      <div class="stat-card"><span>近 30 天</span><strong>${fmtNum(stats.last30)}</strong><em>连续记录中</em></div>
      <div class="stat-card"><span>模型数</span><strong>${fmtNum(stats.models.length)}</strong><em>参与测试的模型</em></div>
      <div class="stat-card"><span>失败率</span><strong>${esc(errorRate)}</strong><em>${fmtNum(errors ? errors.count : 0)} 条标记为失败</em></div>
      <div class="stat-card"><span>当前页平均耗时</span><strong>${esc(avgLatency)}</strong><em>基于已加载的 ${state.records.length} 条</em></div>
      <div class="stat-card"><span>数据占用</span><strong>${fmtBytes(stats.db_bytes + stats.file_bytes)}</strong><em>库 ${fmtBytes(stats.db_bytes)} · 附件 ${fmtBytes(stats.file_bytes)}</em></div>
      <div class="stat-card"><span>服务运行</span><strong>${fmtNum(Math.round(stats.uptime_seconds / 60))} 分</strong><em>版本已就绪</em></div>
    </section>

    <section class="panel">
      <h3>近 14 天登记量 <small>柱高按当天记录数</small></h3>
      <div class="bar-chart">${chart}</div>
    </section>

    <section class="panel">
      <h3>模型分布 <small>按记录数排序</small></h3>
      <div class="dist-list">${models}</div>
    </section>

    <section class="panel">
      <h3>结果类型分布</h3>
      <div class="dist-list">${types}</div>
    </section>

    <section class="panel">
      <h3>标签分布 <small>出现次数</small></h3>
      <div class="dist-list">${tags}</div>
    </section>

    <section class="stats-grid-two">
      <div class="panel">
        <h3>思考等级分布 <small>模型推理强度</small></h3>
        <div class="dist-list">${reasoning}</div>
      </div>
      <div class="panel">
        <h3>Harness 分布 <small>执行工具覆盖</small></h3>
        <div class="dist-list">${harnesses}</div>
      </div>
    </section>`;
}

/* ------------------------------------------------------------------ *
 * 接口文档视图
 * ------------------------------------------------------------------ */

function renderDocs() {
  const base = location.origin;
  const endpoints = [
    ['POST', '/api/records', '登记一条记录（支持数组批量，单次最多 200 条）'],
    ['GET', '/api/records', '列表：q / model / tag / batch / type / status / reasoning_effort / harness / from / to / limit / offset / order'],
    ['GET', '/api/records/:id', '单条详情'],
    ['PATCH', '/api/records/:id', '更新标题 / 标签 / 批次 / meta 等'],
    ['DELETE', '/api/records/:id', '删除一条'],
    ['POST', '/api/records/bulk-delete', '批量删除 {"ids":["rec_..."]}'],
    ['POST', '/api/records/:id/attachments', '追加附件（base64 / data URL / 远程 URL）'],
    ['GET', '/api/facets', '筛选面板数据（模型 / 标签 / 类型 / 状态 / 批次计数）'],
    ['GET', '/api/stats', '统计概览'],
    ['GET', '/api/batches', '批次列表'],
    ['POST', '/api/batches', '新建批次 {"name":"..."}'],
    ['POST', '/api/files', '单独上传文件（原始二进制 ?name=x.png，或 JSON base64）'],
    ['GET', '/api/export?format=json|ndjson|csv', '导出（支持与列表相同的筛选参数）'],
    ['GET', '/api/help', '接口自述（机器可读，含字段别名表）'],
    ['GET', '/r/:id', '把某条记录的结果当网页打开'],
    ['GET', '/health', '健康检查'],
  ]
    .map(
      ([method, path, desc]) => `
      <div class="endpoint">
        <span class="method ${method.toLowerCase()}">${method}</span>
        <code>${esc(path)}</code>
        <span class="desc">${esc(desc)}</span>
      </div>`,
    )
    .join('');

  const aliases = [
    ['prompt', 'prompt / prompt_text / input / user_prompt / question / query / messages'],
    ['model', 'model / model_name / model_id / engine'],
    ['reasoning_effort', 'reasoning_effort（标准字段，不做别名兼容）'],
    ['harness', 'harness（标准字段，不做别名兼容）'],
    ['result', 'result / output / response / content / answer / completion / text / html'],
    ['parts', 'parts / results / outputs / items / blocks（多段结果，数组）'],
    ['result_type', 'result_type / format / output_type / content_type / type（不传自动推断）'],
    ['tags', 'tags / tag / labels / keywords（数组或逗号分隔字符串）'],
    ['batch', 'batch / batch_name / group / session / run_id / test_id（同名自动建批次）'],
    ['status', 'status / state / ok / success（"error"/false 会标记为失败）'],
    ['latency_ms', 'latency_ms / latency / duration / duration_ms / elapsed_ms'],
    ['usage', 'tokens_in / prompt_tokens、tokens_out / completion_tokens、cost / price'],
    ['created_at', 'created_at / time / timestamp / ts / date（ISO 字符串或秒/毫秒时间戳）'],
    ['idempotency_key', 'idempotency_key / request_id / trace_id（重复提交只返回已有记录）'],
    ['attachments', 'attachments / files / images / image_url（支持 base64、data URL、远程 URL）'],
    ['meta', 'meta / metadata / extra（其他无法识别的字段统一进 meta._extra）'],
  ]
    .map(
      ([canonical, alias]) => `<tr><th><code>${esc(canonical)}</code></th><td><code>${esc(alias)}</code></td></tr>`,
    )
    .join('');

  const samples = [
    {
      title: '① 最小登记（文本结果）',
      code: `curl -X POST ${base}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "gpt-5.1",
    "reasoning_effort": "high",
    "harness": "codex",
    "prompt": "用三句话解释 RAG",
    "result": "第一句……",
    "tags": ["rag", "文本"],
    "latency_ms": 1840,
    "tokens_in": 62,
    "tokens_out": 208,
    "cost": 0.0003
  }'`,
    },
    {
      title: '② HTML 结果（界面里沙箱渲染）',
      code: `curl -X POST ${base}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{
    "title": "深色跑分卡",
    "model": "gpt-5.1-codex",
    "prompt": "生成一个深色主题的跑分卡片",
    "result_type": "html",
    "result": "<div style=\\"padding:16px;background:#151513;color:#f4f1ea\\">score 91.4</div>",
    "batch": "2026-09-17 UI 对比"
  }'`,
    },
    {
      title: '③ 直接上传一段 HTML 文件当结果',
      code: `curl -X POST "${base}/api/records?model=gpt-5.1&prompt=做个落地页&result_type=html" \\
  -H 'Content-Type: text/html' \\
  --data-binary @page.html`,
    },
    {
      title: '④ 多段结果（文本 + HTML）',
      code: `curl -X POST ${base}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "claude-sonnet-5",
    "prompt": "先给结论，再给一个卡片",
    "parts": [
      {"type": "text", "label": "结论", "content": "两者差距不大。"},
      {"type": "html", "label": "卡片", "content": "<b style=\\"color:#c96442\\">A vs B</b>"}
    ]
  }'`,
    },
    {
      title: '⑤ 带图片附件（base64 / data URL）',
      code: `curl -X POST ${base}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "gpt-image-2",
    "prompt": "画一只猫",
    "result_type": "image",
    "attachments": [{"name": "cat.png", "data_url": "data:image/png;base64,iVBORw0KGgo..."}]
  }'`,
    },
    {
      title: '⑥ 幂等登记（脚本重试不会重复写入）',
      code: `curl -X POST ${base}/api/records \\
  -H 'Content-Type: application/json' \\
  -d '{"request_id":"run-20260917-001","model":"gpt-5.1","prompt":"你好","result":"你好"}'`,
    },
    {
      title: '⑦ 读取列表 / 按批次对比',
      code: `curl "${base}/api/records?limit=20&order=desc"
curl "${base}/api/records?batch=2026-09-17%20UI%20%E5%AF%B9%E6%AF%94"
curl "${base}/api/records?reasoning_effort=high&harness=codex"`,
    },
  ]
    .map(
      (sample) => `
    <div class="code-card" style="margin-top:10px">
      <div class="code-head"><span>${esc(sample.title)}</span><span class="spacer"></span><button class="ghost-button" data-act="copy-code">复制</button></div>
      <pre>${esc(sample.code)}</pre>
    </div>`,
    )
    .join('');

  $('#content').innerHTML = `
    <div class="page-head">
      <div>
        <h2>接口文档</h2>
        <p>全部接口<strong>无需鉴权</strong>，允许跨域（CORS <code>*</code>），可直接从脚本、其他工具或浏览器页面调用。</p>
      </div>
      <div class="actions">
        <button class="button" data-act="copy-base">复制 Base URL</button>
        <a class="button" href="/api/help" target="_blank" rel="noopener">查看 /api/help</a>
      </div>
    </div>

    <div class="doc-grid">
      <section class="panel">
        <h3>Base URL</h3>
        <div class="code-card">
          <div class="code-head"><span>服务地址</span><span class="spacer"></span><button class="ghost-button" data-act="copy-base">复制</button></div>
          <pre>${esc(base)}</pre>
        </div>
        <div class="doc-note" style="margin-top:10px">
          记录时间既可以由服务端自动打点（不传 <code>created_at</code>），也可以由调用方补录历史时间（传 ISO 字符串或秒/毫秒时间戳）。
        </div>
      </section>

      <section class="panel">
        <h3>接口一览</h3>
        ${endpoints}
      </section>

      <section class="panel">
        <h3>字段别名 <small>调用方不用背字段名</small></h3>
        <table class="kv-table"><tbody>${aliases}</tbody></table>
        <div class="doc-note" style="margin-top:10px">
          无法识别的字段不会丢，会原样保存到 <code>meta._extra</code>；响应里可以随时取回。
        </div>
      </section>

      <section class="panel">
        <h3>调用示例</h3>
        ${samples}
      </section>

      <section class="panel">
        <h3>返回体样例</h3>
        <div class="code-card">
          <div class="code-head"><span>POST /api/records → 201</span><span class="spacer"></span><button class="ghost-button" data-act="copy-code">复制</button></div>
          <pre>${esc(`{
  "ok": true,
  "duplicate": false,
  "id": "rec_mf3k9x_7f3a1c",
  "created_at": "2026-09-17T03:48:12.006Z",
  "created_at_local": "2026-09-17 11:48:12",
  "title": "用三句话解释 RAG",
  "model": "gpt-5.1",
  "reasoning_effort": "high",
  "harness": "codex",
  "result_type": "text",
  "url": "${base}/r/rec_mf3k9x_7f3a1c"
}`)}</pre>
        </div>
      </section>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * 侧栏
 * ------------------------------------------------------------------ */

function renderFacets() {
  const facets = state.facets;
  $('#reasoningFilterSection').hidden = !facets.reasoning_efforts.length;
  $('#harnessFilterSection').hidden = !facets.harnesses.length;
  $('#modelFilterSection').hidden = !facets.models.length;
  $('#tagFilterSection').hidden = !facets.tags.length;
  $('#batchFilterSection').hidden = !facets.batches.length;

  $('#rangeFilter').innerHTML = RANGES.map(
    (r) => `<button class="chip ${state.filters.range === r.id ? 'active' : ''}" data-act="range" data-value="${r.id}">${esc(r.label)}</button>`,
  ).join('');

  $('#typeFilter').innerHTML = TYPES.map((t) => {
    const hit = facets.types.find((x) => x.type === t.id);
    if (!hit) return '';
    return `<button class="chip ${state.filters.types.includes(t.id) ? 'active' : ''}" data-act="type" data-value="${t.id}">${esc(t.label)} ${hit.count}</button>`;
  }).join('') || '<span class="facet-empty">暂无</span>';

  $('#statusFilter').innerHTML = STATUSES.map((s) => {
    const hit = facets.statuses.find((x) => x.status === s.id);
    if (!hit) return '';
    return `<button class="chip ${state.filters.status.includes(s.id) ? 'active' : ''}" data-act="status" data-value="${s.id}">${esc(s.label)} ${hit.count}</button>`;
  }).join('') || '<span class="facet-empty">暂无</span>';

  $('#reasoningFilter').innerHTML = facets.reasoning_efforts.length
    ? facets.reasoning_efforts
        .map(
          (item) => `<button class="chip ${state.filters.reasoning_efforts.includes(item.reasoning_effort) ? 'active' : ''}" data-act="reasoning" data-value="${esc(item.reasoning_effort)}">${esc(item.reasoning_effort)} ${item.count}</button>`,
        )
        .join('')
    : '<span class="facet-empty">暂无</span>';

  $('#harnessFilter').innerHTML = facets.harnesses.length
    ? facets.harnesses
        .map(
          (item) => `<button class="chip ${state.filters.harnesses.includes(item.harness) ? 'active' : ''}" data-act="harness" data-value="${esc(item.harness)}">${esc(item.harness)} ${item.count}</button>`,
        )
        .join('')
    : '<span class="facet-empty">暂无</span>';

  $('#modelFilterHint').textContent = `${facets.models.length} 个`;
  $('#modelFilter').innerHTML = facets.models.length
    ? facets.models
        .map(
          (m) => `<button class="facet ${state.filters.models.includes(m.model) ? 'active' : ''}" data-act="model" data-value="${esc(m.model)}">
        <span class="name" title="${esc(m.model)}">${esc(m.model)}</span><span class="count">${m.count}</span>
      </button>`,
        )
        .join('')
    : '<span class="facet-empty">暂无模型</span>';

  $('#tagFilterHint').textContent = `${facets.tags.length} 个`;
  $('#tagFilter').innerHTML = facets.tags.length
    ? facets.tags
        .slice(0, 40)
        .map(
          (t) => `<button class="chip ${state.filters.tags.includes(t.tag) ? 'active' : ''}" data-act="tag" data-value="${esc(t.tag)}">#${esc(t.tag)} ${t.count}</button>`,
        )
        .join('')
    : '<span class="facet-empty">暂无标签</span>';

  $('#batchFilter').innerHTML = facets.batches.length
    ? facets.batches
        .map(
          (b) => `<button class="facet ${state.filters.batch_id === b.id ? 'active' : ''}" data-act="batch" data-value="${esc(b.id)}" data-name="${esc(b.name)}">
        <span class="name" title="${esc(b.name)}">${esc(b.name)}</span><span class="count">${b.count}</span>
      </button>`,
        )
        .join('')
    : '<span class="facet-empty">暂无批次</span>';

  const total = state.stats ? state.stats.total : facets.models.reduce((sum, m) => sum + m.count, 0);
  $('#navCountAll').textContent = fmtNum(total);
  $('#navCountBatches').textContent = fmtNum(facets.batches.length);
  $('#navCountCompare').textContent = state.compare.length ? String(state.compare.length) : '';
  $('#footTotal').textContent = fmtNum(total);
  $('#footBackend').textContent = state.stats ? (state.stats.backend === 'sqlite' ? 'SQLite' : 'JSON') : '—';
  $('#footSize').textContent = state.stats ? fmtBytes(state.stats.db_bytes + state.stats.file_bytes) : '—';
}

function updateResultCount() {
  const el = $('#resultCount');
  el.textContent = state.total ? `${state.records.length} / ${state.total} 条` : '暂无记录';
}

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */

let modalCleanup = null;

function closeModal() {
  const root = $('#modalRoot');
  root.hidden = true;
  root.innerHTML = '';
  if (modalCleanup) {
    modalCleanup();
    modalCleanup = null;
  }
  document.body.style.overflow = '';
}

function openModal({ title, body, footer = '', size = '', onMount }) {
  // 用一个全新的 #modalRoot 替换旧节点：旧节点上累积的点击/粘贴监听会随节点一起丢掉，
  // 否则同一个表单打开两次后，一次「保存」会触发两次请求。
  const previous = document.getElementById('modalRoot');
  const root = previous.cloneNode(false);
  previous.replaceWith(root);
  root.hidden = false;
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${size}" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="icon-button" data-act="close-modal" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
      </div>
    </div>`;

  // 点击遮罩空白处关闭（只认背景本身，点内容不关闭）
  const backdrop = root.querySelector('.modal-backdrop');
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModal();
  });
  root.querySelector('[data-act="close-modal"]').addEventListener('click', () => closeModal());

  document.body.style.overflow = 'hidden';
  hydrateFrames(root);
  const onKey = (event) => {
    if (event.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', onKey);
  modalCleanup = () => document.removeEventListener('keydown', onKey);
  if (onMount) onMount(root);
  return root;
}

function confirmDialog({ title = '确认操作', message = '', confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const root = openModal({
      title,
      size: 'narrow',
      body: `<p style="font-size:13.5px;line-height:1.7">${esc(message)}</p>`,
      footer: `<button class="button" data-act="cancel">取消</button>
               <button class="button ${danger ? 'danger' : 'primary'}" data-act="ok">${esc(confirmText)}</button>`,
    });
    root.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'ok') {
        finish(true);
        closeModal();
      } else if (act.dataset.act === 'cancel' || act.dataset.act === 'close-modal') {
        finish(false);
        closeModal();
      }
    });
    // 点遮罩或按 Esc 关闭时视为取消
    const observer = new MutationObserver(() => {
      if ($('#modalRoot').hidden) {
        finish(false);
        observer.disconnect();
      }
    });
    observer.observe($('#modalRoot'), { attributes: true, attributeFilter: ['hidden'] });
  });
}

/* ------------------------------------------------------------------ *
 * 图片查看器：独立浮层，叠在弹窗之上，就地看大图，不跳新页面
 * ------------------------------------------------------------------ */

const viewer = { root: null, items: [], index: 0, zoomed: false, returnFocus: null };

function ensureViewer() {
  if (viewer.root) return viewer.root;
  const root = document.createElement('div');
  root.className = 'viewer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '图片预览');
  root.innerHTML = `
    <div class="viewer-bar">
      <div class="viewer-title"><strong data-viewer-name></strong><span data-viewer-meta></span></div>
      <button type="button" class="viewer-tool" data-viewer="zoom"></button>
      <a class="viewer-tool" data-viewer="download" download>${icon('download', 15)}<span>下载</span></a>
      <button type="button" class="viewer-tool icon-only" data-viewer="close" aria-label="关闭（Esc）" title="关闭（Esc）">${icon('close', 17)}</button>
    </div>
    <div class="viewer-stage" data-viewer="stage">
      <img class="viewer-img" data-viewer="img" alt="">
    </div>
    <button type="button" class="viewer-nav prev" data-viewer="prev" aria-label="上一张（←）">${icon('prev', 20)}</button>
    <button type="button" class="viewer-nav next" data-viewer="next" aria-label="下一张（→）">${icon('next', 20)}</button>`;
  document.body.appendChild(root);

  const img = root.querySelector('[data-viewer="img"]');
  img.addEventListener('load', () => {
    root.classList.remove('is-loading');
    updateViewerMeta();
  });
  img.addEventListener('error', () => root.classList.remove('is-loading'));

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-viewer]');
    const role = target ? target.dataset.viewer : '';
    if (role === 'close' || role === 'stage') closeImageViewer();
    else if (role === 'prev') stepImageViewer(-1);
    else if (role === 'next') stepImageViewer(1);
    else if (role === 'zoom' || role === 'img') toggleViewerZoom(event);
  });

  // 捕获阶段先拦住按键：Esc 只关查看器，不连带关掉下面的弹窗
  window.addEventListener(
    'keydown',
    (event) => {
      if (root.hidden) return;
      if (event.key === 'Escape') closeImageViewer();
      else if (event.key === 'ArrowLeft') stepImageViewer(-1);
      else if (event.key === 'ArrowRight') stepImageViewer(1);
      else if (event.key === 'Tab') {
        // 焦点留在查看器里
        const focusable = $$('button:not([hidden]), a[href]', root).filter((node) => node.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          first.focus();
        } else return;
      } else return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );

  viewer.root = root;
  return root;
}

function openImageViewer(items, index = 0) {
  if (!items.length) return;
  const root = ensureViewer();
  viewer.items = items;
  viewer.returnFocus = document.activeElement;
  root.hidden = false;
  document.body.classList.add('viewer-open');
  showViewerImage(index);
  root.querySelector('[data-viewer="close"]').focus({ preventScroll: true });
}

function closeImageViewer() {
  if (!viewer.root || viewer.root.hidden) return;
  viewer.root.hidden = true;
  document.body.classList.remove('viewer-open');
  viewer.root.querySelector('[data-viewer="img"]').removeAttribute('src');
  if (viewer.returnFocus && document.contains(viewer.returnFocus)) viewer.returnFocus.focus({ preventScroll: true });
}

function stepImageViewer(delta) {
  if (viewer.items.length < 2) return;
  showViewerImage((viewer.index + delta + viewer.items.length) % viewer.items.length);
}

function showViewerImage(index) {
  const root = viewer.root;
  const item = viewer.items[index];
  viewer.index = index;
  viewer.zoomed = false;
  root.classList.remove('zoomed');
  root.classList.add('is-loading');
  root.classList.toggle('single', viewer.items.length < 2);
  const img = root.querySelector('[data-viewer="img"]');
  img.alt = item.name;
  img.src = item.url;
  const download = root.querySelector('[data-viewer="download"]');
  download.href = item.url;
  download.setAttribute('download', item.name || '');
  root.querySelector('[data-viewer-name]').textContent = item.name || '图片';
  updateViewerMeta();
}

function updateViewerMeta() {
  const root = viewer.root;
  const img = root.querySelector('[data-viewer="img"]');
  const bits = [];
  if (img.naturalWidth) bits.push(`${img.naturalWidth} × ${img.naturalHeight}`);
  if (viewer.items.length > 1) bits.push(`${viewer.index + 1} / ${viewer.items.length}`);
  root.querySelector('[data-viewer-meta]').textContent = bits.join(' · ');
  // 图比屏幕小时没有「原始尺寸」可切
  const stage = root.querySelector('[data-viewer="stage"]');
  const fits = img.naturalWidth <= stage.clientWidth - 48 && img.naturalHeight <= stage.clientHeight - 48;
  root.classList.toggle('can-zoom', !!img.naturalWidth && !fits);
  root.querySelector('[data-viewer="zoom"]').innerHTML = viewer.zoomed
    ? `${icon('zoom-out', 15)}<span>适应屏幕</span>`
    : `${icon('zoom-in', 15)}<span>原始尺寸</span>`;
}

function toggleViewerZoom(event) {
  const root = viewer.root;
  if (!root.classList.contains('can-zoom')) return;
  const stage = root.querySelector('[data-viewer="stage"]');
  const img = root.querySelector('[data-viewer="img"]');
  // 以点击位置为中心放大，看哪儿点哪儿
  const rect = img.getBoundingClientRect();
  const fx = event.target === img ? (event.clientX - rect.left) / rect.width : 0.5;
  const fy = event.target === img ? (event.clientY - rect.top) / rect.height : 0.5;
  viewer.zoomed = !viewer.zoomed;
  root.classList.toggle('zoomed', viewer.zoomed);
  updateViewerMeta();
  if (viewer.zoomed) {
    stage.scrollLeft = img.offsetWidth * fx - stage.clientWidth / 2;
    stage.scrollTop = img.offsetHeight * fy - stage.clientHeight / 2;
  }
}

/** 同一张卡片 / 弹窗里的图片连成一组，可以左右翻 */
function openLightboxFrom(link) {
  const scope = link.closest('.record-card, .compare-col, .modal, .content') || document.body;
  const seen = new Set();
  const items = $$('[data-act="lightbox"]', scope)
    .map((node) => ({ url: node.dataset.url || node.getAttribute('href'), name: node.dataset.name || '' }))
    .filter((item) => item.url && !seen.has(item.url) && seen.add(item.url));
  const url = link.dataset.url || link.getAttribute('href');
  openImageViewer(items, Math.max(0, items.findIndex((item) => item.url === url)));
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-act="lightbox"]');
  if (!link) return;
  // ⌘/Ctrl/Shift/中键点击仍按浏览器习惯在新标签打开
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  openLightboxFrom(link);
});

function openDetail(record) {
  const ui = recordUi(record.id);
  openModal({
    title: record.title || '(无标题记录)',
    size: 'wide',
    body: `
      <div class="detail-meta">
        ${record.model ? `<span class="badge model">${esc(record.model)}</span>` : ''}
        ${record.reasoning_effort ? `<span class="badge">思考 ${esc(record.reasoning_effort)}</span>` : ''}
        ${record.harness ? `<span class="badge">Harness ${esc(record.harness)}</span>` : ''}
        <span class="badge">${esc(typeLabel(record.result_type))}</span>
        ${statusBadge(record)}
        ${(record.tags || []).map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}
      </div>
      <div class="record-sub" style="margin-bottom:12px">
        <span>记录时间 ${esc(fmtAbs(record.created_at_ms))}</span><span class="dot"></span><span>${esc(fmtRel(record.created_at_ms))}</span>
        ${record.latency_ms ? `<span class="dot"></span><span>耗时 ${fmtNum(record.latency_ms)} ms</span>` : ''}
        ${record.total_tokens ? `<span class="dot"></span><span>${fmtNum(record.total_tokens)} tokens</span>` : ''}
      </div>
      ${record.prompt ? `<section class="block"><div class="block-head"><span class="label">提示词</span><span class="spacer"></span><button class="ghost-button" data-act="copy-prompt">复制</button></div><div class="prompt-text">${esc(record.prompt)}</div></section>` : ''}
      <section class="block">
        <div class="block-head">
          <span class="label">结果</span><span class="type-chip">${esc(typeLabel(record.result_type))}</span><span class="spacer"></span>
          <div class="block-actions">
            ${record.result_type === 'html' && record.result ? modeSwitchHtml(ui.mode) : ''}
            <button class="ghost-button" data-act="copy">复制</button>
            <button class="ghost-button" data-act="download">下载</button>
          </div>
        </div>
        <div class="result-body">${renderResultBody(record, { full: true, collapsible: false })}</div>
      </section>
      ${
        record.attachments && record.attachments.length
          ? `<section class="block"><div class="block-head"><span class="label">附件 ${record.attachments.length}</span></div>
            <div class="result-body"><div class="image-grid">${record.attachments
              .map(
                (a) =>
                  a.kind === 'image'
                    ? `<a class="image-item" href="${esc(a.url)}" data-act="lightbox" data-url="${esc(a.url)}" data-name="${esc(a.name)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy"></a>`
                    : `<a class="ghost-button" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.name)}（${fmtBytes(a.size)}）</a>`,
              )
              .join('')}</div></div></section>`
          : ''
      }
      <section class="block"><div class="block-head"><span class="label">原始数据</span><span class="spacer"></span><button class="ghost-button" data-act="copy-json">复制 JSON</button></div>
        <div class="result-body"><pre class="code-block">${esc(JSON.stringify(record, null, 2))}</pre></div>
      </section>`,
    footer: `<button class="button" data-act="edit">编辑</button>
             <a class="button" href="/r/${encodeURIComponent(record.id)}" target="_blank" rel="noopener">打开结果页</a>
             <span class="spacer"></span>
             <button class="button danger" data-act="delete">删除</button>`,
    onMount(root) {
      root.addEventListener('click', (event) => {
        const el = event.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        if (act === 'copy') copyRecordResult(record);
        else if (act === 'copy-prompt') copyText(record.prompt || '');
        else if (act === 'copy-json') copyText(JSON.stringify(record, null, 2));
        else if (act === 'download') downloadRecordResult(record);
        else if (act === 'edit') {
          closeModal();
          openEditForm(record);
        } else if (act === 'delete') {
          closeModal();
          deleteRecord(record);
        } else if (act === 'mode') {
          ui.mode = el.dataset.mode;
          openDetail(record);
        } else if (act === 'frame-reload') {
          const frame = el.closest('.frame-wrap')?.querySelector('iframe[data-frame]');
          if (frame) loadFrame(frame);
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ *
 * 文件上传：文件「就是结果内容」，附件是额外的可选东西
 * ------------------------------------------------------------------ */

const uploadState = {
  // 保存时一起上传的附加文件
  pending: [],
  // 记录已有的附件（编辑时展示，可移除）
  existing: [],
  // 作为「结果」的那个文件：{ file } 表示保存时才上传，{ url } 表示记录里已有的文件结果
  resultFile: null,
  // 用户把原有的文件结果改回文本输入
  resultCleared: false,
};

const uploadPreviews = new WeakMap();
let previewTimer = null;
let draftFrameKey = null;

const TEXT_TYPE_BY_EXT = {
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  txt: 'text',
  csv: 'text',
  log: 'text',
  svg: 'code',
  js: 'code',
  mjs: 'code',
  ts: 'code',
  css: 'code',
  py: 'code',
  sh: 'code',
  sql: 'code',
  xml: 'code',
  yml: 'code',
  yaml: 'code',
};

function isImageFile(file) {
  return /^image\//.test((file && file.type) || '') || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test((file && file.name) || '');
}

function isTextFile(file) {
  const name = (file && file.name) || '';
  if (file && /^image\//.test(file.type || '')) return false;
  return /^text\//.test((file && file.type) || '') || new RegExp(`\\.(${Object.keys(TEXT_TYPE_BY_EXT).join('|')})$`, 'i').test(name);
}

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].slice(0, 4).toLowerCase() : 'file';
}

function typeFromName(name) {
  return TEXT_TYPE_BY_EXT[fileExt(name)] || '';
}

function previewFor(file) {
  if (!isImageFile(file)) return '';
  if (!uploadPreviews.has(file)) {
    try {
      uploadPreviews.set(file, URL.createObjectURL(file));
    } catch {
      return '';
    }
  }
  return uploadPreviews.get(file);
}

/* -------------------------- 附件（可选） -------------------------- */

function uploadListHtml() {
  const rows = [];
  uploadState.existing.forEach((att, index) => {
    rows.push(`
      <div class="upload-item">
        ${att.kind === 'image' ? `<img src="${esc(att.url)}" alt="">` : `<span class="file-icon">${esc(fileExt(att.name))}</span>`}
        <span class="name" title="${esc(att.name)}">${esc(att.name)}</span>
        <span class="size">${fmtBytes(att.size)}</span>
        <a class="ghost-button" href="${esc(att.url)}" target="_blank" rel="noopener">打开</a>
        <button class="ghost-button" type="button" data-act="remove-existing" data-index="${index}">移除</button>
      </div>`);
  });
  uploadState.pending.forEach((file, index) => {
    const preview = previewFor(file);
    rows.push(`
      <div class="upload-item">
        ${preview ? `<img src="${esc(preview)}" alt="">` : `<span class="file-icon">${esc(fileExt(file.name))}</span>`}
        <span class="name" title="${esc(file.name)}">${esc(file.name)}</span>
        <span class="size">${fmtBytes(file.size)}</span>
        <button class="ghost-button" type="button" data-act="remove-file" data-index="${index}">移除</button>
      </div>`);
  });
  if (!rows.length) return '<div class="upload-empty">没有额外附件。只有想给这条记录再挂几张图/文件时才需要。</div>';
  return `<div class="upload-list">${rows.join('')}</div>`;
}

function uploadFieldHtml() {
  return `
    <div class="field" id="uploadSection">
      <label>附加文件（可选）<em class="label-note">额外挂在记录上的图片 / 文件，会显示在卡片底部</em></label>
      <div class="dropzone slim" id="dropzone">
        <input type="file" class="file-overlay" id="attachFileInput" multiple aria-label="选择附加文件">
        <span>把附加文件拖到这里，或</span>
        <span class="ghost-button">选择附加文件</span>
        <span class="spacer"></span>
        <span class="hint">Ctrl / ⌘ + V 粘贴的截图也会作为附件</span>
      </div>
      <div id="uploadList">${uploadListHtml()}</div>
    </div>`;
}

function refreshUploadList() {
  const holder = $('#uploadList');
  if (holder) holder.innerHTML = uploadListHtml();
}

/* ----------------------- 结果文件（= 内容） ----------------------- */

function resultPreviewHtml() {
  const rf = uploadState.resultFile;
  if (rf) {
    const name = rf.name || basenameOf(rf.url) || '结果文件';
    const size = Number.isFinite(rf.size) ? fmtBytes(rf.size) : '';
    const url = rf.previewUrl || rf.url || '';
    const image = rf.kind === 'image';
    const preview = image && url ? `<div class="file-preview"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy"></div>` : '';
    return `<div class="file-card">
    <div class="file-card-head">
      <span class="file-icon">${esc(fileExt(name))}</span>
      <span class="file-meta">
        <strong>${esc(name)}</strong>
        <span>${esc(rf.mime || '')}${rf.mime && size ? ' · ' : ''}${esc(size)}${rf.file ? ' · 保存时上传' : ''}</span>
      </span>
      <span class="spacer"></span>
      ${rf.url ? `<a class="ghost-button" href="${esc(rf.url)}" target="_blank" rel="noopener">打开</a>` : ''}
      <button class="ghost-button" type="button" data-act="clear-result-file">改回文本输入</button>
    </div>
    ${preview}
  </div>`;
  }

  // 文本结果：HTML / Markdown 给一份实时预览，省得保存后才发现没渲染
  const resultEl = $('#f-result');
  const typeEl = $('#f-type');
  const value = resultEl ? resultEl.value : '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 12) return '';
  const explicit = typeEl ? typeEl.value : '';
  const looksHtml = explicit === 'html' || (!explicit && /^<[a-z!/]/i.test(trimmed));
  const looksMd = explicit === 'markdown' || (!explicit && (/(^|\n)#{1,4}\s+\S/.test(value) || value.includes('```')));

  if (looksHtml) {
    if (draftFrameKey) frames.delete(draftFrameKey);
    draftFrameKey = `draft-${++frameSeq}`;
    return `<div class="preview-label">实时预览 · 保存后卡片里也是这样渲染</div>${renderHtmlFrame(null, value, {
      key: draftFrameKey,
      note: false,
      collapsible: false,
    })}`;
  }
  if (looksMd) {
    return `<div class="preview-label">实时预览</div><div class="markdown">${mdToHtml(value)}</div>`;
  }
  return '';
}

function refreshResultPreview() {
  const holder = $('#resultPreview');
  if (!holder) return;
  holder.innerHTML = resultPreviewHtml();
  hydrateFrames(holder);
}

/** 把选中的文件变成结果：文本类读内容，其它存成文件结果 */
async function setResultFile(file) {
  if (!file) return;
  const resultEl = $('#f-result');
  const typeEl = $('#f-type');

  if (isTextFile(file)) {
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      toast(`读取文件失败：${err.message}`, 'error');
      return;
    }
    uploadState.resultFile = null;
    uploadState.resultCleared = false;
    if (resultEl) {
      resultEl.disabled = false;
      resultEl.value = text;
    }
    const type = typeFromName(file.name);
    if (typeEl && type) typeEl.value = type;
    refreshResultPreview();
    toast(`已把 ${file.name} 的内容读入结果`, 'ok');
    return;
  }

  const image = isImageFile(file);
  uploadState.resultFile = {
    file,
    name: file.name,
    mime: file.type || '',
    size: file.size,
    kind: image ? 'image' : 'file',
    previewUrl: image ? previewFor(file) : '',
  };
  uploadState.resultCleared = false;
  if (resultEl) {
    resultEl.value = '';
    resultEl.disabled = true;
    resultEl.placeholder = `已选择文件作为结果：${file.name}（保存时上传）`;
  }
  if (typeEl) typeEl.value = image ? 'image' : 'file';
  refreshResultPreview();
  toast(`已选择 ${file.name} 作为结果，保存时自动上传`, 'ok');
}

function clearResultFile() {
  const rf = uploadState.resultFile;
  if (rf && rf.previewUrl) URL.revokeObjectURL(rf.previewUrl);
  uploadState.resultCleared = Boolean(rf && rf.url);
  uploadState.resultFile = null;
  const resultEl = $('#f-result');
  if (resultEl) {
    resultEl.disabled = false;
    resultEl.placeholder = '文本、HTML、Markdown、JSON 都可以，直接粘贴';
  }
  refreshResultPreview();
  toast('已改回文本输入', 'ok');
}

function resetUploadState(record) {
  uploadState.pending = [];
  uploadState.resultFile = null;
  uploadState.resultCleared = false;
  uploadState.existing = record && Array.isArray(record.attachments) ? record.attachments.slice() : [];

  // 编辑一条「文件型结果」的记录：把原文件显示出来，不要塞进文本框
  const result = String((record && record.result) || '').trim();
  if (record && (record.result_type === 'image' || record.result_type === 'file') && result.startsWith('/files/')) {
    const meta = (record.attachments || []).find((a) => a && a.url === result) || null;
    uploadState.resultFile = {
      url: result,
      name: (meta && meta.name) || basenameOf(result),
      mime: (meta && meta.mime) || '',
      size: meta && Number.isFinite(meta.size) ? meta.size : null,
      kind: record.result_type === 'image' ? 'image' : 'file',
      previewUrl: '',
    };
  }
}

/* --------------------------- 上传与绑定 --------------------------- */

async function uploadPendingFiles(files = uploadState.pending) {
  const out = [];
  for (const file of files) {
    const params = new URLSearchParams({ name: file.name || 'upload.bin', mime: file.type || '', raw: '1' });
    const res = await fetch(`/api/files?${params.toString()}`, { method: 'POST', body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `上传失败：${file.name}`);
    out.push(data.attachment);
  }
  return out;
}

function makeDropTarget(zone, onFiles, highlight = zone, onText = null) {
  if (!zone) return;
  // dragenter/dragleave 会在子元素之间反复触发，用计数避免高亮闪烁
  let depth = 0;
  const light = (on) => {
    if (highlight) highlight.classList.toggle('dragover', on);
  };

  zone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    event.stopPropagation();
    depth += 1;
    light(true);
  });
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', (event) => {
    event.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) light(false);
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    depth = 0;
    light(false);
    const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
    if (files.length) {
      onFiles(files);
      return;
    }
    // 有些来源（邮件客户端、别的网页）拖过来只有文本/HTML，没有文件
    if (onText && event.dataTransfer) {
      const text = event.dataTransfer.getData('text/html') || event.dataTransfer.getData('text/plain') || '';
      if (text.trim()) onText(text);
    }
  });
}

/**
 * 给弹窗挂上「拖拽 / 点选 / 粘贴」三种入口（结果区 + 附件区）。
 *
 * 关键点：不调 JS 的 input.click()、不用 label[for]、也不用 hidden。
 * 每个区各自内嵌一个「铺满整条虚线框、完全透明」的 <input type="file">，
 * 点击直接落在 input 上、由浏览器原生打开选择器 —— 中间没有环节可以失败。
 */
function wireUploadArea(root) {
  const resultZone = $('#resultDrop', root);
  const attachZone = $('#dropzone', root);

  const addAttachments = (files) => {
    const list = Array.from(files || []).filter((f) => f && (f.name || f.size));
    if (!list.length) return;
    uploadState.pending.push(...list);
    refreshUploadList();
    toast(`已加入 ${list.length} 个附件`, 'ok');
  };

  const asResult = (files) => {
    const file = Array.from(files || []).find(Boolean);
    if (file) setResultFile(file);
  };

  const resultInput = $('#resultFileInput', root);
  const attachInput = $('#attachFileInput', root);
  if (resultInput) {
    resultInput.addEventListener('change', () => {
      const files = Array.from(resultInput.files || []);
      resultInput.value = ''; // 允许连续选同一个文件
      asResult(files);
    });
  }
  if (attachInput) {
    attachInput.addEventListener('change', () => {
      const files = Array.from(attachInput.files || []);
      attachInput.value = '';
      addAttachments(files);
    });
  }

  const asDroppedText = (text) => setResultText(text);
  makeDropTarget(resultZone, asResult, resultZone, asDroppedText);
  makeDropTarget(attachZone, addAttachments, attachZone);
  // 整个弹窗都是落点：拖到文本框、标签、空白处都当作「结果文件」，
  // 否则用户拖偏一点就悄无声息地什么都没发生。
  makeDropTarget(root, asResult, resultZone, asDroppedText);

  root.addEventListener('paste', (event) => {
    const files = (event.clipboardData && event.clipboardData.files) || [];
    if (!files.length) return;
    event.preventDefault();
    const resultEl = $('#f-result');
    const resultEmpty = !uploadState.resultFile && resultEl && !resultEl.value.trim();
    if (resultEmpty) asResult(files);
    else addAttachments(files);
  });
}

/** 拖进来的不是文件而是 HTML / 文本片段时，直接灌进结果框 */
function setResultText(text) {
  const value = String(text || '');
  if (!value.trim()) return;
  const resultEl = $('#f-result');
  const typeEl = $('#f-type');
  if (resultEl) {
    resultEl.disabled = false;
    resultEl.value = value;
  }
  uploadState.resultFile = null;
  uploadState.resultCleared = false;
  if (typeEl && !typeEl.value) typeEl.value = /^\s*<[a-z!/]/i.test(value) ? 'html' : 'text';
  refreshResultPreview();
  toast('已把拖入的内容作为结果', 'ok');
}

/* ------------------------------------------------------------------ *
 * 表单
 * ------------------------------------------------------------------ */

function recordFormBody(record = {}) {
  resetUploadState(record);
  const resultFile = uploadState.resultFile;
  const modelOptions = state.facets.models.map((m) => `<option value="${esc(m.model)}"></option>`).join('');
  const batchOptions = state.facets.batches.map((b) => `<option value="${esc(b.name)}"></option>`).join('');
  const reasoningOptions = [...new Set([...REASONING_EFFORTS, ...state.facets.reasoning_efforts.map((item) => item.reasoning_effort)])]
    .filter(Boolean)
    .map((value) => `<option value="${esc(value)}"></option>`)
    .join('');
  const harnessOptions = [...new Set([...HARNESSES, ...state.facets.harnesses.map((item) => item.harness)])]
    .filter(Boolean)
    .map((value) => `<option value="${esc(value)}"></option>`)
    .join('');
  const localTime = record.created_at_ms ? new Date(record.created_at_ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return `
    <section class="form-section">
      <div class="form-section-head">
        <span class="form-section-step">01</span>
        <div><h4>测试条件</h4><p>先锁定模型、思考等级和执行 Harness。</p></div>
      </div>
      <div class="field">
        <label for="f-title">标题</label>
        <input class="input" id="f-title" value="${esc(record.title || '')}" placeholder="留空会自动取提示词首行">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-model">模型</label>
          <input class="input" id="f-model" list="model-options" value="${esc(record.model || '')}" placeholder="gpt-5.1">
          <datalist id="model-options">${modelOptions}</datalist>
        </div>
        <div class="field">
          <label for="f-reasoning">思考等级</label>
          <input class="input" id="f-reasoning" list="reasoning-options" value="${esc(record.reasoning_effort || '')}" placeholder="none / low / medium / high">
          <datalist id="reasoning-options">${reasoningOptions}</datalist>
        </div>
        <div class="field">
          <label for="f-harness">Harness</label>
          <input class="input" id="f-harness" list="harness-options" value="${esc(record.harness || '')}" placeholder="codex / claude-code / cursor">
          <datalist id="harness-options">${harnessOptions}</datalist>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-type">结果类型</label>
          <select id="f-type">
            <option value="">自动推断</option>
            ${TYPES.map((t) => `<option value="${t.id}" ${record.result_type === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="f-status">状态</label>
          <select id="f-status">
            ${STATUSES.map((s) => `<option value="${s.id}" ${(record.status || 'ok') === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>
    <section class="form-section">
      <div class="form-section-head">
        <span class="form-section-step">02</span>
        <div><h4>测试内容</h4><p>提示词与模型输出，结果文件可以直接拖入。</p></div>
      </div>
      <div class="field">
        <label for="f-prompt">提示词</label>
        <textarea class="textarea" id="f-prompt" placeholder="这次测试用的提示词">${esc(record.prompt || '')}</textarea>
      </div>
      <div class="field">
        <label for="f-result">结果内容 <em class="label-note">文本直接写；文件拖进来就是结果</em></label>
        <div class="dropzone" id="resultDrop">
          <input type="file" class="file-overlay" id="resultFileInput" multiple aria-label="选择文件作为结果">
          <span>把结果文件拖到这里，或</span>
          <span class="ghost-button">选择文件作为结果</span>
          <span class="spacer"></span>
          <span class="hint">HTML / MD / JSON / TXT 读取内容；图片、PDF、压缩包等存成文件结果</span>
        </div>
        <textarea class="textarea" id="f-result" style="min-height:180px" placeholder="${resultFile ? `已选择文件作为结果：${esc(resultFile.name)}` : '文本、HTML、Markdown、JSON 都可以，直接粘贴'}" ${resultFile ? 'disabled' : ''}>${resultFile ? '' : esc(record.result || '')}</textarea>
        <span class="hint">HTML 会在界面里用沙箱 iframe 渲染，可以正常执行脚本、加载样式。</span>
        <div id="resultPreview">${resultPreviewHtml()}</div>
      </div>
    </section>
    <section class="form-section">
      <div class="form-section-head">
        <span class="form-section-step">03</span>
        <div><h4>归档信息</h4><p>批次、标签、性能指标和附加文件。</p></div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-tags">标签</label>
          <input class="input" id="f-tags" value="${esc((record.tags || []).join(', '))}" placeholder="逗号分隔，如：对比, 数学">
        </div>
        <div class="field">
          <label for="f-batch">批次</label>
          <input class="input" id="f-batch" list="batch-options" value="${esc(record.batch_name || '')}" placeholder="同批次可一键对比">
          <datalist id="batch-options">${batchOptions}</datalist>
        </div>
      </div>
      ${uploadFieldHtml()}
      <div class="field-row">
        <div class="field">
          <label for="f-latency">耗时（毫秒）</label>
          <input class="input" id="f-latency" type="number" min="0" value="${record.latency_ms === null || record.latency_ms === undefined ? '' : esc(record.latency_ms)}">
        </div>
        <div class="field">
          <label for="f-tokens">总 tokens</label>
          <input class="input" id="f-tokens" type="number" min="0" value="${record.total_tokens ? esc(record.total_tokens) : ''}">
        </div>
        <div class="field">
          <label for="f-time">记录时间 <em class="label-note">留空则用当前时间</em></label>
          <input class="input" id="f-time" type="datetime-local" value="${esc(localTime)}">
        </div>
      </div>
      <div class="field">
        <label for="f-note">备注</label>
        <input class="input" id="f-note" value="${esc((record.meta && record.meta.note) || '')}" placeholder="可选">
      </div>
    </section>`;
}

function readForm() {
  const value = (id) => {
    const el = $(id);
    return el ? el.value.trim() : '';
  };
  const payload = {
    title: value('#f-title'),
    prompt: value('#f-prompt'),
    model: value('#f-model'),
    reasoning_effort: value('#f-reasoning'),
    harness: value('#f-harness'),
    result: value('#f-result'),
    result_type: value('#f-type'),
    status: value('#f-status') || 'ok',
    tags: value('#f-tags'),
    batch: value('#f-batch'),
    note: value('#f-note'),
  };
  const latency = value('#f-latency');
  if (latency) payload.latency_ms = Number(latency);
  const tokens = value('#f-tokens');
  if (tokens) payload.total_tokens = Number(tokens);
  const time = value('#f-time');
  if (time) payload.created_at = new Date(time).toISOString();
  for (const key of Object.keys(payload)) {
    if (payload[key] === '' || payload[key] === undefined) delete payload[key];
  }
  return payload;
}

/** 新建 / 编辑表单的公共交互：文件入口、附件增删、实时预览、保存 */
function wireRecordForm(root, { record = null, mode = 'create' } = {}) {
  wireUploadArea(root);

  // 一边写一边预览（HTML / Markdown），不用等保存
  const resultEl = $('#f-result');
  const typeEl = $('#f-type');
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refreshResultPreview, 320);
  };
  if (resultEl) resultEl.addEventListener('input', schedulePreview);
  if (typeEl) typeEl.addEventListener('change', schedulePreview);
  refreshResultPreview(); // 编辑已有记录时，一打开就给出预览

  root.addEventListener('click', async (event) => {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;

    if (act === 'clear-result-file') return clearResultFile();

    if (act === 'remove-file') {
      const index = Number(el.dataset.index);
      const [removed] = uploadState.pending.splice(index, 1);
      const preview = removed ? uploadPreviews.get(removed) : '';
      if (preview) URL.revokeObjectURL(preview);
      refreshUploadList();
      return;
    }
    if (act === 'remove-existing') {
      uploadState.existing.splice(Number(el.dataset.index), 1);
      refreshUploadList();
      return;
    }
    if (act === 'cancel') {
      closeModal();
      return;
    }

    if (act === 'save') {
      el.disabled = true;
      try {
        const payload = readForm();

        // 附件：编辑时先提交「保留哪些」，再追加新上传的
        if (mode === 'edit') payload.attachments = uploadState.existing;
        if (uploadState.pending.length) {
          const uploaded = await uploadPendingFiles();
          if (mode === 'create') payload.attachments = uploaded;
          else payload.add_attachments = uploaded;
          uploadState.pending = [];
          refreshUploadList();
        }

        // 结果文件：保存时才真正上传，避免取消表单时留下孤儿文件
        if (uploadState.resultFile && uploadState.resultFile.file) {
          const [att] = await uploadPendingFiles([uploadState.resultFile.file]);
          payload.result = att.url;
          payload.result_type = att.kind === 'image' ? 'image' : 'file';
        } else if (uploadState.resultCleared) {
          payload.result = '';
          payload.result_type = 'text';
        }

        if (mode === 'create') {
          const res = await api.post('/api/records', payload);
          toast(`已保存 ${res.id}`, 'ok');
        } else {
          await api.patch(`/api/records/${encodeURIComponent(record.id)}`, payload);
          toast('已更新', 'ok');
        }
        closeModal();
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
        el.disabled = false;
      }
    }
  });
}

function openCreateForm() {
  openModal({
    title: '新建记录',
    size: 'wide',
    body: recordFormBody(),
    footer: `<span class="spacer"></span>
             <button class="button" data-act="cancel">取消</button>
             <button class="button primary" data-act="save">保存记录</button>`,
    onMount(root) {
      wireRecordForm(root, { mode: 'create' });
    },
  });
}

function openEditForm(record) {
  openModal({
    title: '编辑记录',
    size: 'wide',
    body: recordFormBody(record),
    footer: `<span class="spacer"></span>
             <button class="button" data-act="cancel">取消</button>
             <button class="button primary" data-act="save">保存修改</button>`,
    onMount(root) {
      wireRecordForm(root, { record, mode: 'edit' });
    },
  });
}

async function deleteRecord(record) {
  const ok = await confirmDialog({
    title: '删除记录',
    message: `确定删除「${record.title || record.id}」吗？附件文件也会一起删除，操作不可撤销。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/records/${encodeURIComponent(record.id)}`);
    state.compare = state.compare.filter((id) => id !== record.id);
    toast('已删除', 'ok');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------------------------------------------ *
 * 复制 / 下载
 * ------------------------------------------------------------------ */

function recordResultText(record, { source = false } = {}) {
  if (record.result_type === 'html' && source) return record.result || '';
  if (record.parts && record.parts.length > 1 && !source) {
    return record.parts.map((p) => `----- ${p.label || p.type} -----\n${p.content}`).join('\n\n');
  }
  return record.result || '';
}

function copyRecordResult(record) {
  const ui = recordUi(record.id);
  copyText(recordResultText(record, { source: ui.mode === 'source' }));
}

function downloadRecordResult(record) {
  const isHtml = record.result_type === 'html';
  const ext = isHtml ? 'html' : record.result_type === 'json' ? 'json' : record.result_type === 'markdown' ? 'md' : 'txt';
  const name = `${(record.title || record.id).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)}.${ext}`;
  downloadText(name, record.result || '', isHtml ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8');
}

/* ------------------------------------------------------------------ *
 * 数据加载
 * ------------------------------------------------------------------ */

async function loadRecords({ append = false } = {}) {
  state.loading = true;
  if (!append) {
    state.offset = 0;
    state.records = [];
    if (state.view === 'list') renderList();
  }

  const params = new URLSearchParams();
  const f = state.filters;
  if (f.q) params.set('q', f.q);
  f.models.forEach((m) => params.append('model', m));
  f.tags.forEach((t) => params.append('tag', t));
  f.types.forEach((t) => params.append('type', t));
  f.status.forEach((s) => params.append('status', s));
  f.reasoning_efforts.forEach((value) => params.append('reasoning_effort', value));
  f.harnesses.forEach((value) => params.append('harness', value));
  if (f.batch_id) params.set('batch_id', f.batch_id);
  const from = rangeFrom(f.range);
  if (from) params.set('from', String(from));
  params.set('limit', String(state.limit));
  params.set('offset', String(state.offset));
  params.set('order', state.order);

  try {
    const data = await api.get(`/api/records?${params.toString()}`);
    state.total = data.total;
    state.records = append ? [...state.records, ...data.items] : data.items;
    for (const record of data.items) if (!state.ui[record.id]) state.ui[record.id] = { mode: 'preview', promptOpen: false, full: false };
  } catch (err) {
    toast(`加载失败：${err.message}`, 'error');
  } finally {
    state.loading = false;
  }
  renderCurrentView();
  updateResultCount();
}

async function loadFacets() {
  try {
    const data = await api.get('/api/facets');
    state.facets = {
      models: data.models || [],
      tags: data.tags || [],
      types: data.types || [],
      statuses: data.statuses || [],
      reasoning_efforts: data.reasoning_efforts || [],
      harnesses: data.harnesses || [],
      batches: data.batches || [],
    };
  } catch (err) {
    toast(`筛选数据加载失败：${err.message}`, 'error');
  }
  renderFacets();
}

async function loadStats() {
  try {
    state.stats = await api.get('/api/stats');
  } catch (err) {
    toast(`统计加载失败：${err.message}`, 'error');
  }
  renderFacets();
}

async function refreshAll() {
  await Promise.all([loadRecords(), loadFacets(), loadStats()]);
  if (state.view === 'batches' || state.view === 'compare' || state.view === 'stats' || state.view === 'docs') renderCurrentView();
}

function renderCurrentView() {
  if (state.view === 'list') renderList();
  else if (state.view === 'batches') renderBatches();
  else if (state.view === 'compare') renderCompare();
  else if (state.view === 'stats') renderStats();
  else if (state.view === 'docs') renderDocs();
}

function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.body.classList.remove('sidebar-open');
  if (view === 'stats') {
    renderStats();
    loadStats().then(() => renderStats());
  } else {
    renderCurrentView();
  }
  $('#content').scrollIntoView({ block: 'start' });
}

function toggleFacet(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  else list.push(value);
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

function bindEvents() {
  // 侧栏导航
  $('#nav').addEventListener('click', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item) return;
    setView(item.dataset.view);
  });

  // 侧栏筛选
  $('#sidebar').addEventListener('click', async (event) => {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const value = el.dataset.value;
    if (act === 'range') {
      state.filters.range = value;
    } else if (act === 'type') {
      toggleFacet(state.filters.types, value);
    } else if (act === 'status') {
      toggleFacet(state.filters.status, value);
    } else if (act === 'reasoning') {
      toggleFacet(state.filters.reasoning_efforts, value);
    } else if (act === 'harness') {
      toggleFacet(state.filters.harnesses, value);
    } else if (act === 'model') {
      toggleFacet(state.filters.models, value);
    } else if (act === 'tag') {
      toggleFacet(state.filters.tags, value);
    } else if (act === 'batch') {
      state.filters.batch_id = state.filters.batch_id === value ? '' : value;
    } else {
      return;
    }
    renderFacets();
    state.view = 'list';
    $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'list'));
    await loadRecords();
  });

  $('#clearFilters').addEventListener('click', () => {
    state.filters = {
      q: '',
      models: [],
      tags: [],
      types: [],
      status: [],
      reasoning_efforts: [],
      harnesses: [],
      batch_id: '',
      range: 'all',
    };
    $('#searchInput').value = '';
    renderFacets();
    loadRecords();
  });

  // 搜索
  let searchTimer = null;
  $('#searchInput').addEventListener('input', (event) => {
    state.filters.q = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.view = 'list';
      loadRecords();
    }, 260);
  });

  $('#sortSelect').addEventListener('change', (event) => {
    state.order = event.target.value;
    loadRecords();
  });

  $('#densityToggle').addEventListener('click', (event) => {
    const button = event.target.closest('[data-density]');
    if (!button) return;
    applyDensity(button.dataset.density);
  });

  $('#pageSizeSelect').addEventListener('change', (event) => {
    state.limit = Number(event.target.value);
    loadRecords();
  });

  // 头部 / 侧栏按钮
  $('#newRecordButton').addEventListener('click', openCreateForm);
  $('#refreshButton').addEventListener('click', async () => {
    await refreshAll();
    toast('已刷新', 'ok');
  });
  $('#exportButton').addEventListener('click', () => {
    window.open('/api/export?format=json&download=1', '_blank');
  });
  $('#themeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
  $('.sidebar-head').addEventListener('click', (event) => {
    // 收起后整个窄轨头部都是「展开」热区；展开状态下只有按钮本身会收起，避免误触
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    if (!collapsed && !event.target.closest('#sidebarToggle')) return;
    toggleSidebar();
  });
  $('#mobileMenu').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-open');
  });

  // 内容区
  $('#content').addEventListener('click', async (event) => {
    const el = event.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const card = el.closest('.record-card, .compare-col');
    const id = card ? card.dataset.id : null;
    const record = id ? state.records.find((r) => r.id === id) : null;
    if (record) recordUi(record.id);

    if (act === 'copy-code') {
      const code = el.closest('.code-card')?.querySelector('pre');
      if (code) copyText(code.textContent);
      return;
    }
    if (act === 'copy-base') {
      copyText(location.origin);
      return;
    }
    if (act === 'load-more') {
      state.offset += state.limit;
      await loadRecords({ append: true });
      return;
    }
    if (act === 'clear-compare') {
      state.compare = [];
      renderFacets();
      renderCurrentView();
      return;
    }
    if (act === 'goto-compare') {
      setView('compare');
      return;
    }
    if (act === 'goto-list') {
      setView('list');
      return;
    }
    if (act === 'refresh') {
      await loadStats();
      renderStats();
      return;
    }
    if (act === 'filter-tag') {
      const tag = el.dataset.tag;
      if (!state.filters.tags.includes(tag)) state.filters.tags.push(tag);
      state.view = 'list';
      $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === 'list'));
      renderFacets();
      await loadRecords();
      return;
    }
    if (act === 'remove-filter') {
      const kind = el.dataset.kind;
      const value = el.dataset.value;
      if (kind === 'model') state.filters.models = state.filters.models.filter((item) => item !== value);
      else if (kind === 'tag') state.filters.tags = state.filters.tags.filter((item) => item !== value);
      else if (kind === 'type') state.filters.types = state.filters.types.filter((item) => item !== value);
      else if (kind === 'status') state.filters.status = state.filters.status.filter((item) => item !== value);
      else if (kind === 'reasoning') state.filters.reasoning_efforts = state.filters.reasoning_efforts.filter((item) => item !== value);
      else if (kind === 'harness') state.filters.harnesses = state.filters.harnesses.filter((item) => item !== value);
      else if (kind === 'batch') state.filters.batch_id = '';
      else if (kind === 'range') state.filters.range = 'all';
      renderFacets();
      await loadRecords();
      return;
    }
    if (act === 'clear-filters') {
      state.filters = {
        q: $('#searchInput').value.trim(),
        models: [],
        tags: [],
        types: [],
        status: [],
        reasoning_efforts: [],
        harnesses: [],
        batch_id: '',
        range: 'all',
      };
      renderFacets();
      await loadRecords();
      return;
    }
    if (act === 'new-batch') {
      await createBatch();
      return;
    }
    if (act === 'open-batch') {
      const batchId = el.closest('[data-batch]')?.dataset.batch;
      state.filters.batch_id = batchId;
      setView('list');
      renderFacets();
      await loadRecords();
      return;
    }
    if (act === 'compare-batch') {
      const batchId = el.closest('[data-batch]')?.dataset.batch;
      await pickBatch(batchId);
      return;
    }
    if (act === 'rename-batch') {
      const batchId = el.closest('[data-batch]')?.dataset.batch;
      await renameBatch(batchId);
      return;
    }
    if (act === 'delete-batch') {
      const batchId = el.closest('[data-batch]')?.dataset.batch;
      await removeBatch(batchId);
      return;
    }
    if (act === 'unpick') {
      state.compare = state.compare.filter((x) => x !== id);
      renderFacets();
      renderCurrentView();
      return;
    }
    if (!record) return;

    if (act === 'pick') {
      if (state.compare.includes(record.id)) state.compare = state.compare.filter((x) => x !== record.id);
      else {
        if (state.compare.length >= 4) {
          toast('最多同时对比 4 条', 'error');
          el.checked = false;
          return;
        }
        state.compare.push(record.id);
      }
      renderFacets();
      renderCurrentView();
      return;
    }
    // 下面三个只动卡片自己的那一块，不整页重绘，别的卡片里的 HTML 动画不会被重载
    if (act === 'toggle-prompt') {
      const ui = recordUi(record.id);
      ui.promptOpen = !ui.promptOpen;
      card.querySelector('.prompt-text')?.classList.toggle('clamp', !ui.promptOpen);
      el.classList.toggle('open', ui.promptOpen);
      el.setAttribute('aria-expanded', String(ui.promptOpen));
      el.querySelector('span').textContent = ui.promptOpen ? '收起' : '展开';
      return;
    }
    if (act === 'mode') {
      const ui = recordUi(record.id);
      if (ui.mode === el.dataset.mode) return;
      ui.mode = el.dataset.mode;
      $$('[data-act="mode"]', card).forEach((button) => {
        const active = button.dataset.mode === ui.mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      const body = card.querySelector('.result-body');
      if (body) {
        body.innerHTML = renderResultBody(record, { full: ui.full });
        hydrateFrames(body);
      }
      return;
    }
    if (act === 'frame-full') {
      const ui = recordUi(record.id);
      ui.full = !ui.full;
      const wraps = $$('.frame-wrap.collapsible', card);
      wraps.forEach((wrap) => setFrameExpanded(wrap, ui.full));
      // 收起后如果框顶已经滚出屏幕，把它带回视野，不让人迷路
      const top = wraps[0]?.getBoundingClientRect().top;
      if (!ui.full && top !== undefined && top < 0) wraps[0].scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (act === 'frame-reload') {
      const frame = el.closest('.frame-wrap')?.querySelector('iframe[data-frame]');
      if (frame) loadFrame(frame);
      return;
    }
    if (act === 'copy') {
      copyRecordResult(record);
      return;
    }
    if (act === 'copy-json') {
      copyText(JSON.stringify(record, null, 2));
      return;
    }
    if (act === 'download') {
      downloadRecordResult(record);
      return;
    }
    if (act === 'detail') {
      openDetail(record);
      return;
    }
    if (act === 'edit') {
      openEditForm(record);
      return;
    }
    if (act === 'delete') {
      await deleteRecord(record);
    }
  });

  // 键盘
  document.addEventListener('keydown', (event) => {
    const tag = (event.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target.isContentEditable;
    if (event.key === '/' && !typing) {
      event.preventDefault();
      $('#searchInput').focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#searchInput').focus();
      $('#searchInput').select();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !typing) {
      event.preventDefault();
      toggleSidebar();
    }
  });

  // 文件被拖到页面任意位置都不要让浏览器直接打开它；
  // 弹窗与上传区各自的监听已经 stopPropagation，会自己处理
  ['dragover', 'drop'].forEach((type) => document.addEventListener(type, (event) => event.preventDefault()));
}

/* ------------------------------------------------------------------ *
 * 批次操作
 * ------------------------------------------------------------------ */

async function createBatch() {
  const name = window.prompt('批次名称（同一批次可以在界面上并排对比）');
  if (!name) return;
  try {
    await api.post('/api/batches', { name });
    toast('批次已创建', 'ok');
    await loadFacets();
    renderBatches();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renameBatch(batchId) {
  const batch = (state.facets.batches || []).find((b) => b.id === batchId);
  if (!batch) return;
  const name = window.prompt('新的批次名称', batch.name);
  if (!name || name === batch.name) return;
  try {
    await api.patch(`/api/batches/${encodeURIComponent(batchId)}`, { name });
    toast('已重命名', 'ok');
    await refreshAll();
    renderBatches();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeBatch(batchId) {
  const batch = (state.facets.batches || []).find((b) => b.id === batchId);
  if (!batch) return;
  const ok = await confirmDialog({
    title: '删除批次',
    message: `删除批次「${batch.name}」？批次下的记录不会被删除，只会解除归组。`,
    confirmText: '删除批次',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/batches/${encodeURIComponent(batchId)}`);
    toast('批次已删除', 'ok');
    if (state.filters.batch_id === batchId) state.filters.batch_id = '';
    await refreshAll();
    renderBatches();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pickBatch(batchId) {
  try {
    const data = await api.get(`/api/records?batch_id=${encodeURIComponent(batchId)}&limit=4&order=asc`);
    if (!data.items.length) {
      toast('该批次下还没有记录', 'error');
      return;
    }
    state.compare = data.items.map((r) => r.id);
    state.records = data.items;
    for (const record of data.items) if (!state.ui[record.id]) state.ui[record.id] = { mode: 'preview', promptOpen: false, full: false };
    renderFacets();
    setView('compare');
  } catch (err) {
    toast(err.message, 'error');
  }
}
/* ------------------------------------------------------------------ *
 * 主题 & 启动
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  localStorage.setItem('mtl.theme', document.documentElement.dataset.theme);
}

function applyDensity(density) {
  state.density = density === 'compact' ? 'compact' : 'comfortable';
  document.body.classList.toggle('density-compact', state.density === 'compact');
  refreshFrameCaps();
  $$('#densityToggle [data-density]').forEach((button) => {
    button.classList.toggle('active', button.dataset.density === state.density);
    button.setAttribute('aria-pressed', button.dataset.density === state.density ? 'true' : 'false');
  });
  try {
    localStorage.setItem('mtl.density', state.density);
  } catch {
    /* ignore */
  }
}

function syncSidebarUi() {
  const collapsed = document.body.classList.contains('sidebar-collapsed');
  const button = $('#sidebarToggle');
  if (button) {
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    button.title = collapsed ? '展开侧栏（⌘/Ctrl + B）' : '收起侧栏（⌘/Ctrl + B）';
  }
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', !!collapsed);
  localStorage.setItem('mtl.sidebar', collapsed ? '1' : '0');
  syncSidebarUi();
}

function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
}

async function boot() {
  applyTheme(localStorage.getItem('mtl.theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  applyDensity(localStorage.getItem('mtl.density') || 'comfortable');
  setSidebarCollapsed(localStorage.getItem('mtl.sidebar') === '1' && window.innerWidth > 900);

  state.limit = Number($('#pageSizeSelect').value) || 50;

  bindEvents();
  await loadFacets();
  await loadRecords();
  await loadStats();
  renderFacets();

  const params = new URLSearchParams(location.search);
  const recordId = params.get('record');
  if (recordId) {
    try {
      const data = await api.get(`/api/records/${encodeURIComponent(recordId)}`);
      if (data.record) openDetail(data.record);
    } catch (err) {
      toast(`找不到记录 ${recordId}`, 'error');
    }
  }
}

boot();
