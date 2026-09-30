// 真·前端测试：用 jsdom 跑 public/app.js，对着真服务走一遍「新建记录」流程。
//
// jsdom 是可选依赖（本项目本身零依赖）。装了才会执行：
//   npm i -D jsdom
//   node --test test/ui.test.mjs
// 没装则自动 skip，不影响其余测试。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server.mjs');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-ui-'));
const require = createRequire(import.meta.url);

function loadJsdom() {
  const candidates = ['jsdom', process.env.JSDOM_PATH].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

const jsdomModule = loadJsdom();
const JSDOM = jsdomModule && jsdomModule.JSDOM;

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

/** 打开一个「真」页面：load 服务器上的 index.html，手动 eval app.js（jsdom 不跑 module 脚本） */
async function openPage() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const dom = new JSDOM(html, { url: `${base}/`, runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom 没实现、但 app.js 会用到的浏览器 API
  window.fetch = (input, init) => fetch(new URL(String(input), base), init);
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.URL.createObjectURL = window.URL.createObjectURL || (() => 'blob:stub');
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.confirm = () => true;

  window.eval(app);
  return dom;
}

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等到条件成立（轮询 DOM），超时抛错 */
async function waitFor(fn, { timeout = 6000, step = 40, what = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时`);
    await tick(step);
  }
}

/** 造一个假的 FileList 塞给 <input type="file"> */
function fakeFileList(files) {
  const list = { length: files.length, item: (i) => files[i] || null };
  files.forEach((file, i) => {
    list[i] = file;
  });
  return list;
}

function newHtmlFile(name, content) {
  return new File([content], name, { type: 'text/html' });
}

const HTML_DOC = '<!doctype html><html><body><h1>上传的标题</h1><p>来自文件</p></body></html>';

before(async () => {
  if (!JSDOM) return;
  const started = await startServer();
  child = started.proc;
  base = started.base;
});

after(async () => {
  if (child && !child.killed) child.kill('SIGTERM');
  await tick(300);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('页面能启动并渲染出空状态 / 记录列表', { skip: !JSDOM && '未安装 jsdom（npm i -D jsdom 后可跑）' }, async () => {
  const dom = await openPage();
  const el = await waitFor(() => dom.window.document.querySelector('#resultCount'), { what: '应用启动' });
  assert.ok(el, '顶栏应当渲染出来');
  await waitFor(() => dom.window.document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });
  dom.window.close();
});

test('弹窗里拖入文件后，拖到「结果区之外」也能被接住', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const dropzone = await waitFor(() => document.querySelector('#resultDrop'), { what: '新建记录弹窗' });
  assert.ok(dropzone, '结果区应当有拖拽入口');

  // 模拟把文件拖到弹窗的空白处（不是那个小拖拽框）
  const file = newHtmlFile('report.html', HTML_DOC);
  const dataTransfer = { files: fakeFileList([file]), types: ['Files'] };
  const modalBody = document.querySelector('.modal-body');
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  modalBody.dispatchEvent(event);

  const textarea = document.querySelector('#f-result');
  await waitFor(() => textarea.value.includes('上传的标题'), { what: '文件内容进入结果框' });
  assert.equal(textarea.value, HTML_DOC, 'HTML 文件的内容应当原样进入结果框');
  assert.equal(document.querySelector('#f-type').value, 'html', '结果类型应当自动选成 HTML');
  assert.ok(!document.querySelector('#resultDrop').classList.contains('dragover'), '拖拽高亮要收掉');
  dom.window.close();
});

test('上传文件当结果 → 保存 → 卡片里用沙箱 iframe 渲染', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const input = await waitFor(() => document.querySelector('#resultFileInput'), { what: '新建记录弹窗' });

  // 选文件（浏览器原生的选择器落定后就是 change 事件）
  Object.defineProperty(input, 'files', { configurable: true, value: fakeFileList([newHtmlFile('page.html', HTML_DOC)]) });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));

  const textarea = document.querySelector('#f-result');
  await waitFor(() => textarea.value.includes('上传的标题'), { what: '文件内容进入结果框' });

  document.querySelector('#f-title').value = '上传的 html';
  document.querySelector('#f-model').value = 'gpt-5.1';
  document.querySelector('#f-reasoning').value = 'high';
  document.querySelector('#f-harness').value = 'codex';
  document.querySelector('[data-act="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const card = await waitFor(
    () => Array.from(document.querySelectorAll('.record-card')).find((c) => c.textContent.includes('上传的 html')),
    { what: '保存后列表出现新记录' },
  );
  const frame = card.querySelector('iframe[data-frame]');
  assert.ok(frame, 'HTML 结果必须渲染成沙箱 iframe，而不是纯文本');
  assert.ok(frame.getAttribute('srcdoc').includes('上传的标题'), 'iframe 里应当有上传的 HTML 内容');
  assert.match(frame.getAttribute('sandbox') || '', /allow-scripts/);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { __mtlHeight: 1, id: frame.dataset.frame, h: 2000 } }));
  assert.equal(parseFloat(frame.style.height), 2000, 'iframe 必须按内容的自然高度排版，不能被压扁');
  const wrap = frame.closest('.frame-wrap');
  assert.ok(wrap.classList.contains('is-tall') && !wrap.classList.contains('expanded'), '超出预览上限时折叠态只裁切外框');
  card.querySelector('.frame-more').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(wrap.classList.contains('expanded'), '点「展开完整高度」应原地展开');
  assert.equal(card.querySelector('iframe[data-frame]'), frame, '展开不应重建 iframe（否则动画会重播）');
  assert.ok(!card.querySelector('pre.text-block'), '不应该退化成 <pre> 文本块');
  assert.match(card.textContent, /思考\s*high/);
  assert.match(card.textContent, /Harness\s*codex/);

  const saved = await (await fetch(`${base}/api/records?q=${encodeURIComponent('上传的 html')}`)).json();
  assert.equal(saved.total, 1);
  assert.equal(saved.items[0].result_type, 'html');
  assert.equal(saved.items[0].result, HTML_DOC);
  assert.equal(saved.items[0].reasoning_effort, 'high');
  assert.equal(saved.items[0].harness, 'codex');
  dom.window.close();
});

test('结果为空但挂着 HTML 附件时，卡片兜底把它渲染出来', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  // 先用接口造一条「只有 HTML 附件、没有结果正文」的历史形态记录
  const up = await fetch(`${base}/api/files?name=${encodeURIComponent('page.html')}&mime=${encodeURIComponent('text/html')}&raw=1`, {
    method: 'POST',
    body: Buffer.from(HTML_DOC),
  });
  const att = (await up.json()).attachment;
  assert.match(att.url, /\.html$/i, '上传的应当是 .html 文件');
  const served = await fetch(`${base}${att.url}`);
  assert.match(served.headers.get('content-type'), /text\/html/);
  await served.arrayBuffer();

  await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', prompt: '只有 HTML 附件的记录', attachments: [att] }),
  });

  const dom = await openPage();
  const { document } = dom.window;
  const card = await waitFor(
    () => Array.from(document.querySelectorAll('.record-card')).find((c) => c.textContent.includes('只有 HTML 附件的记录')),
    { what: '新记录渲染出来' },
  );
  const frame = card.querySelector('iframe.result-frame.external');
  assert.ok(frame, '结果为空时应当兜底把 HTML 附件渲染成 iframe');
  assert.match(frame.getAttribute('src'), /^\/files\//);
  assert.ok(!card.textContent.includes('（没有结果内容）'), '不该再显示「没有结果内容」');
  dom.window.close();
});

test('文本框里直接写 HTML 会立刻出现实时预览', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const textarea = await waitFor(() => document.querySelector('#f-result'), { what: '新建记录弹窗' });

  textarea.value = HTML_DOC;
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));

  const frame = await waitFor(() => document.querySelector('#resultPreview iframe[data-frame]'), { what: '实时预览 iframe' });
  assert.ok(frame.getAttribute('srcdoc').includes('上传的标题'), '预览 iframe 里应当有刚写进去的 HTML');
  assert.match(document.querySelector('#resultPreview .preview-label').textContent, /实时预览/);
  dom.window.close();
});

test('结果区里内嵌了铺满整条的透明 file input（点击零中间环节）', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const zone = await waitFor(() => document.querySelector('#resultDrop'), { what: '新建记录弹窗' });

  const input = zone.querySelector('input[type="file"]#resultFileInput');
  assert.ok(input, '结果区里必须有一个 <input type="file">');
  assert.ok(input.classList.contains('file-overlay'), 'file input 要铺满整条区域');
  assert.equal(input.hasAttribute('hidden'), false, '不能用 hidden（有些浏览器会拒绝唤起选择器）');
  assert.equal(input.disabled, false);
  // 点区域里任意位置，命中的都是这个 input
  assert.equal(input.compareDocumentPosition(zone.querySelector('.hint')) & window.Node.DOCUMENT_POSITION_FOLLOWING, window.Node.DOCUMENT_POSITION_FOLLOWING);

  Object.defineProperty(input, 'files', { configurable: true, value: fakeFileList([newHtmlFile('via-input.html', HTML_DOC)]) });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));

  const textarea = document.querySelector('#f-result');
  await waitFor(() => textarea.value.includes('上传的标题'), { what: '选文件后内容进结果框' });
  assert.equal(document.querySelector('#f-type').value, 'html');
  dom.window.close();
});

test('把 HTML 片段（不是文件）拖进弹窗也能变成结果', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const textarea = await waitFor(() => document.querySelector('#f-result'), { what: '新建记录弹窗' });

  // 模拟从别的网页/邮件客户端拖过来：只有 text/html，没有 files
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: fakeFileList([]),
      types: ['text/html'],
      getData: (type) => (type === 'text/html' ? HTML_DOC : ''),
    },
  });
  document.querySelector('.modal-body').dispatchEvent(event);

  await waitFor(() => textarea.value.includes('上传的标题'), { what: '拖入的 HTML 片段进入结果框' });
  assert.equal(document.querySelector('#f-type').value, 'html');
  dom.window.close();
});

test('二进制文件（png）走同一条路：保存为文件型结果并就地预览', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  document.querySelector('#newRecordButton').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const dropzone = await waitFor(() => document.querySelector('#resultDrop'), { what: '新建记录弹窗' });

  const png = new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], 'cat.png', { type: 'image/png' });
  const event = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: fakeFileList([png]), types: ['Files'] } });
  dropzone.dispatchEvent(event);

  await waitFor(() => document.querySelector('#resultPreview .file-card'), { what: '结果文件卡片' });
  assert.equal(document.querySelector('#f-type').value, 'image');
  assert.equal(document.querySelector('#f-result').disabled, true, '选了文件结果后文本框应当被停用');

  document.querySelector('#f-title').value = '上传的 png';
  document.querySelector('[data-act="save"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const card = await waitFor(
    () => Array.from(document.querySelectorAll('.record-card')).find((c) => c.textContent.includes('上传的 png')),
    { what: '保存后列表出现新记录' },
  );
  assert.ok(card.querySelector('.file-preview img, .image-grid img'), '图片型结果应当就地显示图片');

  const saved = await (await fetch(`${base}/api/records?q=${encodeURIComponent('上传的 png')}`)).json();
  assert.equal(saved.items[0].result_type, 'image');
  assert.match(saved.items[0].result, /^\/files\//);
  const diskFile = path.join(DATA_DIR, 'files', decodeURIComponent(saved.items[0].result.replace('/files/', '')));
  assert.ok(fs.existsSync(diskFile), '图片应当真的上传到 data/files');
  dom.window.close();
});

/* ----------------------------- 耗时 / tokens / 记录时间 ----------------------------- */

const click = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

function typeInto(window, el, text) {
  el.value = text;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function findByTitle(title) {
  const data = await (await fetch(`${base}/api/records?q=${encodeURIComponent(title)}`)).json();
  return data.items.find((r) => r.title === title) || null;
}

/** 轮询接口直到 predicate 成立（保存是异步的） */
async function waitForRecord(title, predicate = () => true, what = '记录写入') {
  const deadline = Date.now() + 6000;
  for (;;) {
    const rec = await findByTitle(title);
    if (rec && predicate(rec)) return rec;
    if (Date.now() > deadline) throw new Error(`等待「${what}」超时：${title}`);
    await tick(50);
  }
}

async function createViaApi(body) {
  const res = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'm', prompt: 'p', result: 'r', ...body }),
  });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

/** 打开页面并点开某条记录的「编辑」表单 */
async function openEditFor(title) {
  const dom = await openPage();
  const { document, window } = dom.window;
  const card = await waitFor(
    () => Array.from(document.querySelectorAll('.record-card')).find((c) => c.textContent.includes(title)),
    { what: `列表里出现「${title}」` },
  );
  click(window, card.querySelector('[data-act="edit"]'));
  await waitFor(() => document.querySelector('#f-latency'), { what: '编辑弹窗' });
  return dom;
}

test('新建记录：耗时填 1:30 → 实时回显 → 保存为 90000 ms', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  click(window, document.querySelector('#newRecordButton'));
  const latency = await waitFor(() => document.querySelector('#f-latency'), { what: '新建记录弹窗' });
  const hint = document.querySelector('#f-latency-hint');
  assert.equal(latency.getAttribute('type'), 'text', '耗时输入框必须是文本框，才能写冒号和单位');
  assert.match(hint.textContent, /纯数字按秒算/, '空的时候提示纯数字按秒');

  typeInto(window, latency, '1:30');
  assert.match(hint.textContent, /= 1 分 30 秒（90,000 ms）/);
  assert.ok(!latency.classList.contains('is-invalid'));

  typeInto(window, latency, '45');
  assert.match(hint.textContent, /= 45 秒（45,000 ms）/, '表单里纯数字按秒解释');
  typeInto(window, latency, '1:30');

  document.querySelector('#f-title').value = 'UI 耗时 1:30';
  document.querySelector('#f-model').value = 'gpt-5.1';
  document.querySelector('#f-result').value = '结果';
  click(window, document.querySelector('[data-act="save"]'));

  const saved = await waitForRecord('UI 耗时 1:30');
  assert.equal(saved.latency_ms, 90000);
  dom.window.close();
});

test('新建记录：耗时写成看不懂的内容 → 报错提示、不保存、弹窗还在', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { document, window } = dom.window;
  await waitFor(() => document.querySelector('.empty-state, .record-card'), { what: '列表渲染' });

  click(window, document.querySelector('#newRecordButton'));
  const latency = await waitFor(() => document.querySelector('#f-latency'), { what: '新建记录弹窗' });
  document.querySelector('#f-title').value = 'UI 耗时 abc';
  document.querySelector('#f-model').value = 'gpt-5.1';
  document.querySelector('#f-result').value = '结果';
  typeInto(window, latency, 'abc');
  assert.match(document.querySelector('#f-latency-hint').textContent, /看不懂这个时长/);
  assert.ok(latency.classList.contains('is-invalid'), '无法解析时输入框进入错误态');

  const before = (await (await fetch(`${base}/api/records?limit=1`)).json()).total;
  click(window, document.querySelector('[data-act="save"]'));
  await tick(500);

  const after = (await (await fetch(`${base}/api/records?limit=1`)).json()).total;
  assert.equal(after, before, '不应产生新记录');
  assert.equal(await findByTitle('UI 耗时 abc'), null);
  assert.ok(document.querySelector('#f-latency'), '弹窗应当还在');
  assert.equal(document.activeElement, latency, '应当聚焦到耗时输入框');
  assert.match(document.querySelector('.toast.error, .toast')?.textContent || '', /耗时/);
  assert.equal(document.querySelector('[data-act="save"]').disabled, false, '保存按钮要恢复可点');

  // 改对之后能正常保存
  typeInto(window, latency, '2m30s');
  assert.ok(!latency.classList.contains('is-invalid'));
  click(window, document.querySelector('[data-act="save"]'));
  const saved = await waitForRecord('UI 耗时 abc');
  assert.equal(saved.latency_ms, 150000);
  dom.window.close();
});

test('编辑只改标题：耗时和记录时间（含秒 / 毫秒）原样保留', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  // 故意用带非零秒和毫秒的时间戳：曾经保存一次就会被抹成整分钟
  const createdMs = Math.floor(Date.now() / 60000) * 60000 - 3600000 + 37 * 1000 + 456;
  await createViaApi({ title: 'UI 编辑保留原值', created_at: createdMs, latency_ms: 1840, total_tokens: 100 });
  const original = await findByTitle('UI 编辑保留原值');
  assert.equal(original.created_at_ms, createdMs);

  const dom = await openEditFor('UI 编辑保留原值');
  const { document, window } = dom.window;
  assert.equal(document.querySelector('#f-latency').value, '1.84s', '回填精确写法');
  assert.match(document.querySelector('#f-latency-hint').textContent, /= 1\.84 秒（1,840 ms）/, '打开时先算一次回显');
  assert.equal(document.querySelector('#f-tokens').value, '100');
  assert.match(document.querySelector('#f-time').value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:37$/, '记录时间要能看到秒');
  assert.equal(document.querySelector('#f-time').getAttribute('step'), '1');

  document.querySelector('#f-title').value = 'UI 编辑保留原值（改）';
  click(window, document.querySelector('[data-act="save"]'));
  const saved = await waitForRecord('UI 编辑保留原值（改）');
  assert.equal(saved.created_at_ms, createdMs, '没动过的记录时间不能被抹成整分钟');
  assert.equal(saved.latency_ms, 1840);
  assert.equal(saved.total_tokens, 100);
  dom.window.close();
});

test('编辑：清空耗时和总 tokens 后保存，两者都变成 null', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  await createViaApi({ title: 'UI 编辑清空', latency_ms: 1840, total_tokens: 100 });
  const dom = await openEditFor('UI 编辑清空');
  const { document, window } = dom.window;

  typeInto(window, document.querySelector('#f-latency'), '');
  typeInto(window, document.querySelector('#f-tokens'), '');
  assert.match(document.querySelector('#f-latency-hint').textContent, /纯数字按秒算/);
  click(window, document.querySelector('[data-act="save"]'));

  const saved = await waitForRecord('UI 编辑清空', (r) => r.latency_ms === null && r.total_tokens === null, '耗时与 tokens 被清空');
  assert.equal(saved.latency_ms, null);
  assert.equal(saved.total_tokens, null);
  dom.window.close();
});

test('编辑：改耗时（纯数字按秒）和总 tokens 会真的写进去', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  await createViaApi({ title: 'UI 编辑改值', latency_ms: 1840, total_tokens: 100 });
  const dom = await openEditFor('UI 编辑改值');
  const { document, window } = dom.window;

  typeInto(window, document.querySelector('#f-latency'), '45');
  typeInto(window, document.querySelector('#f-tokens'), '250');
  click(window, document.querySelector('[data-act="save"]'));

  const saved = await waitForRecord('UI 编辑改值', (r) => r.latency_ms === 45000, '耗时被改成 45 秒');
  assert.equal(saved.total_tokens, 250, '编辑「总 tokens」不能被静默丢弃');
  dom.window.close();
});

test('前端 parseDuration / durationInputValue 往返不丢精度', { skip: !JSDOM && '未安装 jsdom' }, async () => {
  const dom = await openPage();
  const { parseDuration, durationInputValue, fmtDuration } = dom.window;
  assert.equal(typeof parseDuration, 'function');
  assert.equal(typeof durationInputValue, 'function');

  for (const ms of [0, 1, 820, 999, 1000, 1001, 1840, 12300, 59999, 60000, 60001, 125000, 125250, 3599999, 3600000, 3723000, 3723004, 86400000, 90061001]) {
    const text = durationInputValue(ms);
    assert.equal(parseDuration(text, 's'), ms, `${ms} -> ${JSON.stringify(text)} 往返后不一致`);
  }
  assert.equal(durationInputValue(null), '');
  assert.equal(durationInputValue(undefined), '');
  assert.equal(durationInputValue(820), '820ms');
  assert.equal(durationInputValue(1840), '1.84s');
  assert.equal(durationInputValue(5000), '5s');
  assert.equal(durationInputValue(125000), '2:05');
  assert.equal(durationInputValue(125250), '2:05.25');
  assert.equal(durationInputValue(3723000), '1:02:03');

  // 前后端解析要一致
  const { parseDurationMs, formatDuration } = await import('../lib/util.mjs');
  const samples = ['1:30', '1:02:03', '2:05.250', '1h2m3s', '2分30秒', '1.5s', '820ms', '1m 30s', '1小时', '30分钟', '250毫秒', '45', '1.5', 'abc', '12x', '1h foo', '-5', '1:75', ''];
  for (const text of samples) {
    for (const unit of ['ms', 's']) {
      const a = parseDurationMs(text, unit);
      const b = parseDuration(text, unit);
      assert.ok(Object.is(a, b), `${JSON.stringify(text)}(${unit})：后端 ${a}，前端 ${b}`);
    }
  }
  for (const ms of [0, 820, 999, 1000, 1840, 12300, 59999, 60000, 125000, 3723000, 86400000 * 3 + 4 * 3600000, NaN, null]) {
    assert.equal(fmtDuration(ms), formatDuration(ms), `fmtDuration(${ms})`);
  }
  dom.window.close();
});
