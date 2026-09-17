#!/usr/bin/env bash
# 启动模型测试记录台（零依赖，只需要 Node）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js 22.5 或更高版本。" >&2
  exit 1
fi

exec node server.mjs "$@"
