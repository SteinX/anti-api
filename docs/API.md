# API Reference / API 参考

## Authentication / 认证

Anti-API uses a simple token-based authentication. The token value can be anything.

Anti-API 使用简单的令牌认证。令牌值可以是任意字符串。

```bash
Authorization: Bearer any-value
# or for Anthropic format:
x-api-key: any-value
```

---

## OpenAI Compatible API

### POST /v1/chat/completions

**Request Example / 请求示例:**

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-value" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

**Response / 响应:**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "claude-sonnet-4-5",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

### Streaming / 流式响应

Set `"stream": true` to receive Server-Sent Events:

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-value" \
  -d '{"model": "claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'
```

**Stream Response:**
```
data: {"id":"chatcmpl-abc","choices":[{"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-abc","choices":[{"delta":{"content":"!"}}]}
data: {"id":"chatcmpl-abc","choices":[{"finish_reason":"stop"}]}
data: [DONE]
```

---

## Anthropic Compatible API

### POST /v1/messages

**Request Example / 请求示例:**

```bash
curl -X POST http://localhost:8964/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any-value" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

**Response / 响应:**

```json
{
  "id": "msg_abc123",
  "type": "message",
  "role": "assistant",
  "content": [{
    "type": "text",
    "text": "Hello! How can I help you today?"
  }],
  "model": "claude-sonnet-4-5",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

---

## Tool Calling / 工具调用

### OpenAI Format

```bash
curl -X POST http://localhost:8964/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer any-value" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

**Tool Call Response:**
```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"Tokyo\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

---

## Error Codes / 错误码

| Status | Description | 描述 |
|--------|-------------|------|
| 200 | Success | 成功 |
| 400 | Bad Request | 请求格式错误 |
| 401 | Unauthorized | 未授权（需要 OAuth 登录）|
| 429 | Rate Limited | 请求过于频繁或配额耗尽 |
| 500 | Server Error | 服务器内部错误 |
| 503 | Upstream Unavailable | 上游服务不可用 |

**Error Response Format:**
```json
{
  "error": {
    "type": "error_type",
    "message": "Error description"
  }
}
```

---

## Models / 支持的模型

| Model ID | Provider | Features |
|----------|----------|----------|
| `claude-sonnet-4-5` | Antigravity | Fast, balanced |
| `claude-sonnet-4-5-thinking` | Antigravity | Extended thinking |
| `claude-opus-4-5-thinking` | Antigravity | Most capable |
| `claude-opus-4-6-thinking` | Antigravity | Most capable (new generation) |
| `gemini-3-flash` | Antigravity | Fast responses |
| `gemini-3-pro-high` | Antigravity | High quality |
| `fast` | Routing | Auto-select fastest |
| `opus` | Routing | Auto-select Opus |

### Using Routing / 使用路由

Prefix model with `route:` to select a custom flow:

```json
{"model": "route:my-custom-flow", "messages": [...]}
```
