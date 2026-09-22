# 模型测试记录台 · Model Test Logbook

[![CI](https://github.com/THQDDQHT/model-test-logbook/actions/workflows/ci.yml/badge.svg)](https://github.com/THQDDQHT/model-test-logbook/actions/workflows/ci.yml)
[![Release](https://github.com/THQDDQHT/model-test-logbook/actions/workflows/release.yml/badge.svg)](https://github.com/THQDDQHT/model-test-logbook/actions/workflows/release.yml)

本地优先的**模型测试记录台**：把每次模型测试的**提示词**和**模型结果**存下来，文字、HTML、Markdown、JSON、图片都能存、都能看。
HTML 结果在界面里用**沙箱 iframe 正常渲染**（真能跑 JS、能加载样式），数据落在本地 SQLite，另提供一套**免鉴权的自动登记接口**，脚本里一行 `curl` 就能写入。

- 零依赖：只用 Node 内置模块（`node:http` + `node:sqlite`），**不需要 `npm install`，不需要构建**。
- 免鉴权：所有接口开放，CORS 允许任意来源，可直接被脚本 / 其他工具 / 浏览器页面调用。
- 时间可追溯：每条记录都带记录时间（列表里同时显示绝对时间与相对时间，并按「今天 / 昨天」分组）。
- 测试条件可筛选：登记时可记录 `reasoning_effort`（思考等级）和 `harness`（执行 Harness 名称）。
- 随手对比：同一批次（同一提示词跑多个模型）的记录可一键并排对比。
- 界面风格参考 `shenbi-maliang-gpt-image-workbench`：暖白底 + 细边框 + 黑色主按钮 + ChatGPT 式左侧栏，另附深色模式。

---

## 快速开始

```bash
cd 2026-09-17-model-test-logbook
node server.mjs
```

启动后终端会打印地址（默认 <http://127.0.0.1:8788>），浏览器打开即可。

```bash
node server.mjs --port 9000        # 换端口（被占用时会自动往后找一个可用端口）
node server.mjs --port 0           # 让系统随便分配一个空闲端口
node server.mjs --host 0.0.0.0     # 允许局域网访问，终端会打印局域网地址
node server.mjs --data-dir /path   # 换数据目录
node server.mjs --no-seed          # 首次启动不写入 3 条示例记录
node server.mjs --max-body-mb 64   # 单次请求体上限（默认 32MB）
./start.sh                         # 等价于 node server.mjs
```

**环境要求**：Node.js ≥ 22.5（推荐 22.17 / 24+），因为用到内置的 `node:sqlite`。
如果 Node 版本偏低，服务会自动回退到 `data/records.json` 文件存储，功能完全一致，只是大数据量下不如 SQLite。

停止服务：`Ctrl+C`（会先落盘再退出）。

---

## Docker 部署

```bash
mkdir -p data                       # 先建好，保证属主是当前用户
docker compose up -d --build        # 本地构建并启动

# 或者直接用已发布镜像（Actions 每次发版都会推到 ghcr.io）
docker compose up -d

# 打开 http://127.0.0.1:8788
docker compose logs -f
docker compose down
```

不想用 compose 也可以：

```bash
docker build -t model-test-logbook .
docker run -d --name model-test-logbook \
  -p 8788:8788 \
  -v "$PWD/data:/app/data" \
  -e TZ=Asia/Shanghai \
  --restart unless-stopped \
  model-test-logbook
```

镜像基于 `node:24-alpine`，以非 root 的 `node` 用户运行，自带 `HEALTHCHECK`。
数据都在挂出来的 `./data` 里（`records.db` + `files/`），备份直接复制这个目录。

> Linux 上如果宿主机 `./data` 的属主不是当前用户导致容器写不进去，把 `docker-compose.yml` 里 `user: "0:0"` 那行注释打开，或执行 `sudo chown -R 1000:1000 data`。

---

## 发布与打包（GitHub Actions）

```
.github/workflows/
├── ci.yml        # push / PR：Node 22 + 24 两档跑测试，真启动服务打一次登记接口；另外验证镜像能构建并跑起来
└── release.yml   # 打 v* tag：跑测试 → 打 tar.gz / zip / sha256 → 建 GitHub Release → 推送镜像到 ghcr.io
```

发一个版本：

```bash
git tag v1.2.0
git push origin v1.2.0
```

产物会挂在 Release 页面（`model-test-logbook-v1.2.0.tar.gz` / `.zip` / `.sha256`），镜像会推到
`ghcr.io/thqddqht/model-test-logbook:v1.2.0`、`:1.2`、`:latest`。
也可以在 Actions 页面手动触发 `Release`，那样只产出 artifact、不建 Release（镜像打 `edge` 标签）。

---

## 目录结构

```
2026-09-17-model-test-logbook/
├── server.mjs            # HTTP 服务：路由 / 静态资源 / 接口
├── lib/
│   ├── store.mjs         # 存储层：SQLite 主实现 + JSON 回退实现
│   ├── payload.mjs       # 请求负载归一化（字段别名、类型推断、种子数据）
│   ├── files.mjs         # 附件落盘与读取
│   └── util.mjs          # 时间 / 类型 / JSON / 转义等工具
├── public/
│   ├── index.html        # 界面骨架（侧栏 + 顶栏 + 内容区）
│   ├── styles.css        # 设计令牌与全部样式（含深色模式）
│   └── app.js            # 前端逻辑（列表 / 对比 / 统计 / 文档 / Markdown 渲染）
├── test/                 # 单元测试 + 接口测试 + 真前端测试（jsdom）
├── examples/
│   └── register.sh       # 用 curl 批量登记的示例脚本
├── Dockerfile            # 零依赖运行镜像
├── docker-compose.yml    # 一键起服务，数据挂到 ./data
├── .github/workflows/    # CI 与发版流水线
├── data/                 # 运行后生成
│   ├── records.db        # SQLite 数据库（回退模式下是 records.json）
│   └── files/            # 上传的图片 / 附件
└── README.md
```

---

## 界面功能

| 区域 | 能力 |
| --- | --- |
| 左侧栏 | 新建记录、全部记录 / 测试批次 / 结果对比 / 统计概览 / 接口文档，按时间范围、结果类型、状态、思考等级、Harness、模型、标签、批次筛选 |
| 顶栏 | 关键词搜索（`/` 或 `⌘K` 聚焦）、排序（最新 / 最早在前）、每页条数、已加载计数 |
| 记录卡片 | 标题、模型徽标、结果类型、状态、记录时间（绝对 + 相对）、标签、提示词折叠、结果渲染、附件缩略图、耗时 / tokens / 成本 / 批次 / 来源 / 记录 ID |
| 新建 / 编辑记录 | 手动填写标题、提示词、模型、思考等级、Harness、结果类型与内容、标签、批次、耗时、tokens、记录时间、备注。**结果本身就是文件时，把文件拖到表单任意位置，或直接点虚线框（整条区域铺着一个透明的原生 file input，点哪都能唤起选择器）、Ctrl⌘+V 粘贴截图，甚至直接把 HTML 片段拖进来**：HTML / MD / JSON / TXT 等文本类会读出内容当结果，图片 / PDF / 压缩包等会存成「文件型结果」。文本结果边写边给**实时预览**（HTML / Markdown 立刻渲染，不用等保存）。另有可选的「附加文件」区，用来给一条记录再挂几张图 |
| 结果渲染 | HTML → 沙箱 iframe（自动高度、可展开全高、可切源码、可新窗口打开）；Markdown → 内置渲染器（含表格 / 代码块 / 引用）；JSON、代码、纯文本 → 等宽块；图片 → 缩略图网格；**文件 → 文件卡片（图片 / PDF / 视频 / 音频就地预览，其它给「新窗口打开 / 下载」）**；多段结果（`parts`）→ 分段渲染 |
| 结果对比 | 勾选 2–4 条记录（或一键选择整个批次），并排查看不同模型的输出 |
| 统计概览 | 总数 / 今天 / 近 7 天 / 近 30 天 / 模型数 / 失败率 / 平均耗时 / 占用空间，近 14 天柱状图，模型 / 类型 / 标签分布 |
| 接口文档 | 页面内直接给出当前服务地址（Base URL）与所有 `curl` 示例，一键复制 |
| 其他 | 侧栏可收起为 56px 窄轨（⌘/Ctrl + B 或点顶部按钮，收起后窄轨整个头部都是展开热区）、深色模式、导出 JSON / NDJSON / CSV、`?record=<id>` 直达某条记录、窄屏自适应 |

HTML 结果的渲染方式：内容被放进 `<iframe sandbox="allow-scripts allow-popups allow-forms allow-modals">`。
沙箱里脚本可以运行、CSS 可以生效，但**没有同源权限**，所以结果里的代码动不了主页面（也拿不到 `localStorage`）。
「新窗口」按钮打开的是 `/r/<id>`，那里直接以 `text/html` 输出结果本身，适合当完整网页看。

---

## 自动登记接口

**统一 Base URL**：`http://127.0.0.1:8788`（换成你的实际地址）
**鉴权**：无。所有 `/api/*` 都返回 `Access-Control-Allow-Origin: *`，支持 `OPTIONS` 预检。
**Content-Type**：`application/json`（推荐）、`application/x-www-form-urlencoded`、`text/plain`、`multipart/form-data` 都可以。

### 最常用：登记一条记录

```bash
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
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
  }'
```

返回：

```json
{
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
  "url": "http://127.0.0.1:8788/r/rec_mf3k9x_7f3a1c"
}
```

### 其它常用写法

```bash
# HTML 结果：界面里会用沙箱 iframe 渲染
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.1-codex","prompt":"做个深色跑分卡","result_type":"html","result":"<div>91.4</div>"}'

# 把一段 HTML 文件直接当结果（字段走 query，正文走 body）
curl -X POST "http://127.0.0.1:8788/api/records?model=gpt-5.1&prompt=做个落地页&result_type=html" \
  -H 'Content-Type: text/html' --data-binary @page.html

# 表单 / multipart 上传
curl -X POST http://127.0.0.1:8788/api/records \
  -F model=gpt-image-2 -F prompt=画一只猫 -F file=@cat.png

# ↑ 字段名是 result / output / content / file / media 时，这个文件「就是结果本身」：
#   文本类（html/md/json/txt…）读出内容当结果，图片/PDF/压缩包等存成文件型结果。
#   字段名是 attachments / files / images 时才是附加附件。

# 已经落盘的文件也可以直接当结果引用
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2","prompt":"画一只猫","result":"/files/xxx-cat.png","result_type":"image"}'

# base64 / data URL 附件
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2","prompt":"画一只猫","result_type":"image",
       "attachments":[{"name":"cat.png","data_url":"data:image/png;base64,iVBORw0KGgo..."}]}'

# 多段结果（文本 + HTML 一起存）
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-5","prompt":"先结论再卡片",
       "parts":[{"type":"text","label":"结论","content":"差距不大。"},
                {"type":"html","label":"卡片","content":"<b>A vs B</b>"}]}'

# 批量登记（数组，一次最多 200 条）
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '[{"model":"m1","prompt":"1+1=?","result":"2"},{"model":"m2","prompt":"1+1=?","result":"2"}]'

# 幂等登记：脚本重试不会重复写入
curl -X POST http://127.0.0.1:8788/api/records \
  -H 'Content-Type: application/json' \
  -d '{"request_id":"run-20260917-001","model":"gpt-5.1","prompt":"你好","result":"你好"}'
```

### 字段一览（全部可选，能写多少写多少）

| 字段 | 说明 |
| --- | --- |
| `prompt` | 提示词。也支持 `messages` 数组（自动拼成可读文本，原文存在 `meta.messages`） |
| `model` | 模型名，界面会聚合成筛选列表 |
| `reasoning_effort` | 思考/推理等级，常用英文值如 `none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`；不传则留空 |
| `harness` | 使用的 Harness 名称，例如 `codex` / `claude-code` / `cursor` / `openai-api`；只记录名称，不传则留空 |
| `result` | 结果正文，字符串。HTML 直接放进来即可（记得设 `result_type`） |
| `result_type` | `text` / `html` / `markdown` / `json` / `code` / `image` / `file` / `mixed` / `error`；**不传会自动推断**（`/files/x.pdf` → `file`，`/files/x.png` → `image`） |
| `parts` | 多段结果数组，元素形如 `{type,label,content}` |
| `title` | 标题；不传则取提示词首行 |
| `tags` | 标签，数组或 `"a,b,c"` 字符串 |
| `batch` | 批次名；不存在会自动创建，同名记录即为一组，可一键并排对比 |
| `batch_id` | 已有批次的 id（也可以只传名字） |
| `status` | `ok` / `error` / `pending` / `running` / `skipped`；传 `ok:false` 或给了 `error` 也判定为失败 |
| `error` | 失败信息 |
| `provider` | 渠道 / 供应商 |
| `latency_ms` | 耗时（毫秒） |
| `tokens_in` / `tokens_out` / `total_tokens` | token 用量（只给前两个会自动求和） |
| `cost` / `currency` | 成本与币种（默认 USD） |
| `created_at` | 记录时间：ISO 字符串（`2026-09-17T11:48:12+08:00`）、`2026-09-17 11:48:12`、秒级或毫秒级时间戳都行；不传用服务器当前时间 |
| `source` | 来源标记，默认 `api` |
| `idempotency_key` | 幂等键（也认 `request_id` / `trace_id` / `dedupe_key`），重复提交只返回已有记录，不新增 |
| `attachments` | 附件数组，元素支持 `data_url` / `base64` / `url`（http 远程引用）/ `name` / `mime` |
| `meta` | 任意对象；**没被识别的字段会自动收进 `meta._extra`，不会丢** |

**字段别名**（调用方不用背字段名，下面任写一个都认）：

| 规范字段 | 可接受的别名 |
| --- | --- |
| `prompt` | `prompt_text` `input` `user_prompt` `question` `query` `messages` |
| `model` | `model_name` `model_id` `engine` |
| `reasoning_effort` | 仅使用标准字段名，不提供别名 |
| `harness` | 仅使用标准字段名，不提供别名 |
| `result` | `output` `response` `content` `answer` `completion` `text` `html` |
| `parts` | `results` `outputs` `items` `blocks` `segments` |
| `result_type` | `format` `output_type` `content_type` `type` |
| `title` | `name` `label` `subject` |
| `tags` | `tag` `labels` `keywords` |
| `batch` | `batch_name` `group` `session` `run_id` `test_id` `suite` |
| `status` | `state` `ok` `success` `passed` |
| `error` | `error_message` `err` `failure` `exception` |
| `latency_ms` | `latency` `duration` `duration_ms` `elapsed_ms` `took_ms` |
| `tokens_in` | `prompt_tokens` `input_tokens` |
| `tokens_out` | `completion_tokens` `output_tokens` |
| `cost` | `price` `usd` `fee` |
| `created_at` | `createdAt` `time` `timestamp` `ts` `date` `logged_at` |
| `idempotency_key` | `request_id` `trace_id` `dedupe_key` |
| `attachments` | `files` `images` `image` `image_url` `screenshot` |
| `meta` | `metadata` `extra` `details` `context` |

### 全部接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/records` | 登记记录（对象 / 数组 / `{"records":[...]}`） |
| GET | `/api/records` | 列表，参数：`q` `model` `tag` `batch_id`（严格批次 id）`batch`（批次 id 或批次名都行）`type` `status` `reasoning_effort` `harness` `source` `from` `to` `limit`(默认 50，≤500) `offset` `order=asc\|desc` `id` |
| GET | `/api/records/:id` | 单条详情 |
| PATCH | `/api/records/:id` | 更新 `title` `tags` `model` `provider` `reasoning_effort` `harness` `status` `result_type` `prompt` `result` `error` `latency_ms` `cost` `created_at` `meta` `note` `batch` `attachments` |
| DELETE | `/api/records/:id` | 删除（连同附件文件） |
| POST | `/api/records/bulk-delete` | 批量删除 `{"ids":["rec_..."]}` |
| POST | `/api/records/:id/attachments` | 追加附件 |
| GET | `/api/facets` | 筛选面板数据（模型 / 标签 / 类型 / 状态计数 + 批次） |
| GET | `/api/stats` | 统计概览 |
| GET | `/api/batches` | 批次列表（含记录数） |
| POST | `/api/batches` | 新建批次 `{"name":"...","note":"..."}` |
| PATCH | `/api/batches/:id` | 重命名批次 `{"name":"..."}` |
| DELETE | `/api/batches/:id` | 删除批次（记录保留，仅解除归组） |
| POST | `/api/files` | 单独上传文件：原始二进制（`?name=x.png&raw=1`）或 JSON `{"name","mime","base64"}`，返回可挂在记录上的附件对象 |
| GET | `/api/export?format=json\|ndjson\|csv` | 导出（支持列表的全部筛选参数，`download=0` 可内联查看） |
| GET | `/api/help` | 接口自述（机器可读，含字段别名表与示例） |
| GET | `/r/:id` | 把某条记录的结果当网页打开；`?part=N` 指定某一段，`?raw=1` 输出原始 HTML，`?download=1` 下载 |
| GET | `/health` | 健康检查（含后端类型、时区、总记录数） |
| GET | `/files/*` | 附件访问 |

### 给 AI / 脚本用的自描述

任何调用方（人或模型）都可以先请求一次 `GET /api/help`，它会返回完整的接口清单、字段别名表和 `curl` 示例，不需要读文档。

---

## 测试

零依赖，直接用 Node 自带的测试运行器：

```bash
npm install                   # 只为测试装 jsdom；服务本身运行时零依赖
npm test                      # 等价于 node --test test/*.test.mjs
node --test test/store.test.mjs   # 只跑某一个文件
```

`test/ui.test.mjs` 需要 jsdom（已列为 devDependency）；没装时它会自动 skip，其余测试照跑。

| 文件 | 覆盖内容 |
| --- | --- |
| `test/util.test.mjs` | 时间解析（ISO / 本地格式 / 秒级与毫秒级时间戳 / 非法值回退）、类型转换、`clampInt` 边界、HTML 转义、CSV 转义、SQL LIKE 转义、`safeDecodeURI`、结果类型推断、标题推导 |
| `test/payload.test.mjs` | 登记接口的字段别名、未识别字段进 `meta._extra`、text+html 拆多段、`parts`、类型推断、成功/失败判定、`created_at` 兜底、base64 / 纯文本 / 远程 URL 附件、中文文件名往返、messages 拼接、批次名校验 |
| `test/store.test.mjs` | SQLite 后端读写与排序分页、全部筛选条件（含 LIKE 转义、批次名/批次 id）、幂等键、更新、删除、**附件孤儿文件回收与跨记录引用计数**、批次 CRUD 与重命名联动、统计聚合 |
| `test/api.test.mjs` | 真启动一个 `server.mjs` 子进程打全部接口：静态页面、健康检查、CORS 预检、登记（JSON / text-plain+query / 数组批量 / **multipart 上传文件当结果**）、幂等、`/r/:id` 直出与 `raw=1` 与文件下载、列表筛选分页、PATCH（含批次自动创建）、**附件与文件型结果的孤儿文件回收**、删除记录连带清文件、统计与三种导出、`/api/help`、404 与 400/413 错误码 |
| `test/frontend.test.mjs` | 前端静态资源自检：`public/app.js` 语法可解析、`$('#id')` 用到的节点确实存在、动态节点确实被创建、`index.html` 引用的静态文件都在、CSS 括号配平、模板字符串闭合、文件即结果的入口已接上 |
| `test/ui.test.mjs` | **真前端测试**（可选依赖 jsdom）：把真服务的 `index.html` + `app.js` 跑起来，模拟拖入 / 选择文件 / 打字，断言「拖到表单任意位置都能被接住」、「结果区整条是 label，点哪都能唤起选择器」、「文件内容进结果框且类型自动识别」、「文本框里写 HTML 立刻出实时预览」、「保存后卡片里出现沙箱 iframe 并带 srcdoc」、「png 存成文件型结果并就地预览」、「结果为空但有 HTML 附件时兜底渲染」 |

---

## 数据与备份

- SQLite 模式：`data/records.db`（+ `-wal` / `-shm`），附件在 `data/files/`。
- 回退模式：`data/records.json`，附件同样在 `data/files/`。
- 备份：直接复制整个 `data/` 目录；或 `GET /api/export?format=json&download=1` 导出全部记录。
- 记录与附件只在本机，服务不做任何外部上报。

---

## 常见问题

**Q：端口被占用？**
服务会自动从指定端口往后找可用端口（最多 20 个），终端打印的就是实际端口。

**Q：HTML 结果里的图片 / CDN 样式加载不出来？**
沙箱 iframe 允许网络请求，正常情况可以加载。若结果里用的是相对路径，请改成绝对 URL 或在结果里内联。

**Q：界面没看到刚登记的数据？**
点侧栏底部的刷新按钮，或直接刷新页面。列表按记录时间倒序，最新在最上面。

**Q：启动时终端出现 `ExperimentalWarning: SQLite is an experimental feature`？**
这是 Node 对内置 `node:sqlite` 的提示，不影响使用；想彻底消掉可以用 `node --no-warnings server.mjs`。

**Q：想清掉示例数据？**
界面上直接删除那 3 条（`source` 显示为 `seed`），或启动时加 `--no-seed`，或删除 `data/` 重建。

**Q：数据量大了会不会卡？**
列表是分页加载（默认 50 条/页）；SQLite 已对 `created_at_ms`、`model`、`batch_id`、`result_type` 建索引。单条结果建议控制在几 MB 以内（请求体上限可调）。
