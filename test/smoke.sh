#!/usr/bin/env bash
# cline2api v2 端到端冒烟测试（真实请求上游 cline.bot）
# 用法: bash test/smoke.sh [PORT]
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8799}"
BASE="http://127.0.0.1:$PORT"
MODEL="cline-cloud/deepseek-v4.1-flash"
PASS=0; FAIL=0

ok()  { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望 [$3] 实际 [$2])"; fi; }
contains(){ if echo "$2" | grep -q -- "$3"; then ok "$1"; else bad "$1 (未找到 [$3])"; fi; }
jget(){ python3 -c 'import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))' "$1" 2>/dev/null || echo "<parse-error>"; }

PORT=$PORT API_KEY="" node server.js > /tmp/cline2api.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break; sleep 0.25; done

echo "=== 1. /v1/health ==="
H=$(curl -s --max-time 30 "$BASE/v1/health")
check "health ok"          "$(echo "$H" | jget d'["ok"]')" "True"
check "上游可达"            "$(echo "$H" | jget d'["upstream"]["reachable"]')" "True"
check "默认模型正确"        "$(echo "$H" | jget d'["default_model"]')" "$MODEL"
check "cloud 层含默认模型"  "$(echo "$H" | jget d'["upstream"]["tiers"]["cloud"][0]')" "$MODEL"
echo "     free 层: $(echo "$H" | jget d'["upstream"]["tiers"]["free"]')"

echo "=== 2. /v1/models ==="
M=$(curl -s --max-time 30 "$BASE/v1/models")
check "列表首项为默认模型" "$(echo "$M" | jget d'["data"][0]["id"]')" "$MODEL"
echo "     共 $(echo "$M" | jget 'len(d["data"])') 个模型"

echo "=== 3. 非流式 chat ==="
R=$(curl -s --max-time 120 "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PONG\"}]}")
contains "拿到内容"     "$R" "PONG"
check "model 回显为客户端所传" "$(echo "$R" | jget d'["model"]')" "$MODEL"
check "object=chat.completion" "$(echo "$R" | jget d'["object"]')" "chat.completion"

echo "=== 4. max_tokens:1 守卫（旧版这里必 500） ==="
R=$(curl -s --max-time 120 "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PONG\"}]}")
if echo "$R" | grep -q "empty response content"; then bad "仍触发上游 500 empty response content"; else contains "max_tokens:1 被守卫，正常返回" "$R" "PONG"; fi

echo "=== 5. 流式 chat ==="
S=$(curl -s --max-time 120 -N "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PONG\"}]}")
contains "收到 chat.completion.chunk" "$S" "chat.completion.chunk"
contains "以 [DONE] 收尾"             "$S" "data: \[DONE\]"
contains "流式内容正确"               "$S" "PONG"

echo "=== 6. 客户端硬编码模型名（gpt-4o）自动映射 ==="
R=$(curl -s --max-time 120 "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}')
contains "gpt-4o 可用" "$R" "PONG"

echo "=== 7. Anthropic 非流式 /v1/messages ==="
A=$(curl -s --max-time 120 "$BASE/v1/messages" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":512,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PONG\"}]}")
check "type=message" "$(echo "$A" | jget d'["type"]')" "message"
contains "content 文本正确" "$A" "PONG"

echo "=== 8. Anthropic 流式 ==="
AS=$(curl -s --max-time 120 -N "$BASE/v1/messages" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":512,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: PONG\"}]}")
for ev in message_start content_block_start content_block_delta message_delta message_stop; do
  contains "有 $ev" "$AS" "event: $ev"
done

echo "=== 9. 404 ==="
check "未知路径 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/nope")" "404"

echo
echo "=== 10. OpenAI tools 透传 ==="
T=$(curl -s --max-time 120 "$BASE/v1/chat/completions" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Tokyo? Use the get_weather tool.\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"description\":\"get weather\",\"parameters\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}}]}")
check "finish_reason=tool_calls" "$(echo "$T" | jget d'["choices"][0]["finish_reason"]')" "tool_calls"
contains "tool_calls 含 get_weather" "$T" "get_weather"

echo "=== 11. Anthropic tools 转换 ==="
AT=$(curl -s --max-time 120 "$BASE/v1/messages" -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":512,\"tools\":[{\"name\":\"get_weather\",\"description\":\"get weather\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"city\":{\"type\":\"string\"}},\"required\":[\"city\"]}}],\"messages\":[{\"role\":\"user\",\"content\":\"What is the weather in Tokyo? Use the tool.\"}]}")
check "stop_reason=tool_use" "$(echo "$AT" | jget d'["stop_reason"]')" "tool_use"
contains "含 tool_use block" "$AT" "tool_use"

echo "=== 12. API_KEY 鉴权模式 ==="
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
PORT=$PORT API_KEY=sk-test-123 node server.js > /tmp/cline2api-auth.log 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -sf "$BASE/v1/health" >/dev/null 2>&1 && break; sleep 0.25; done
check "错误 key → 401" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BASE/v1/chat/completions" -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{}')" "401"
check "正确 key(Bearer) → 200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$BASE/v1/chat/completions" -H 'Authorization: Bearer sk-test-123' -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}")" "200"
check "正确 key(x-api-key) → 200" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$BASE/v1/messages" -H 'x-api-key: sk-test-123' -H 'Content-Type: application/json' -d "{\"model\":\"$MODEL\",\"max_tokens\":256,\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}]}")" "200"

echo "-----------------------------"
echo "通过 $PASS 项，失败 $FAIL 项"
[ "$FAIL" -eq 0 ]
