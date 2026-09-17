#!/usr/bin/env bash
# 自动登记接口示例：连续写入几条不同形态的测试记录
# 用法：./examples/register.sh [base_url]

BASE="${1:-http://127.0.0.1:8788}"
post() {
  echo "--- $1"
  curl -sS -X POST "$BASE/api/records" -H 'Content-Type: application/json' -d "$2" | sed 's/^/    /'
  echo
}

echo "Base URL: $BASE"
echo

post "1) 文本结果" '{
  "model": "gpt-5.1",
  "prompt": "用三句话解释什么是 RAG。",
  "result": "RAG 把检索与生成拼在一起：先找资料，再让模型带着资料回答。",
  "tags": ["示例", "文本"],
  "latency_ms": 1240,
  "tokens_in": 48,
  "tokens_out": 96,
  "cost": 0.0002
}'

post "2) HTML 结果（走 result_type）" '{
  "model": "gpt-5.1-codex",
  "prompt": "生成一个深色主题的模型跑分卡片，输出完整 HTML",
  "result_type": "html",
  "result": "<div style=\"padding:16px;border-radius:12px;background:#151513;color:#f4f1ea;font-family:system-ui\"><b>gpt-5.1-codex</b> · 91.4</div>",
  "batch": "示例 · UI 对比",
  "tags": ["示例", "HTML"]
}'

post "3) 多段结果（文本 + HTML）" '{
  "model": "claude-sonnet-5",
  "prompt": "先给一句结论，再给一个卡片",
  "parts": [
    {"type": "text", "label": "结论", "content": "两者差距不大，长函数补全上 claude 更稳。"},
    {"type": "html", "label": "卡片", "content": "<b style=\"color:#c96442\">A vs B</b>"}
  ],
  "latency_ms": 2740
}'

post "4) 失败记录" '{
  "model": "gpt-5.1",
  "prompt": "触发一次超时",
  "status": "error",
  "error": "request timeout after 60000ms",
  "latency_ms": 60000
}'

post "5) 幂等登记（重复调用只写一条）" '{
  "request_id": "demo-idempotency-001",
  "model": "gpt-5.1",
  "prompt": "幂等测试",
  "result": "第一次写入"
}'

echo "--- 6) 列表（最近 5 条）"
curl -sS "$BASE/api/records?limit=5&order=desc" | head -40 | sed 's/^/    /'
echo
echo "完成。打开 $BASE 即可看到这些记录。"
