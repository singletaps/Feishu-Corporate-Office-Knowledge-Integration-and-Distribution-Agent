# OpenClaw 集成验证记录

> 状态：历史验证记录，已脱敏。本文档只用于追溯 2026-04-27 的本地联调过程，不作为当前架构事实的唯一来源。
>
> 当前代码中的 OpenClaw 主路径是 WebSocket Gateway + device auth；OpenClaw HTTP `/v1/*` 不再作为 LLM 主路径。`agent-tools` HTTP API 仍保留，用于 OpenClaw Skill 调用 FeishuAgent 业务工具。

## 验证时间

2026-04-27

## 已验证通过

### 1. 本地服务状态

| 服务 | 状态 |
| --- | --- |
| OpenClaw Docker | healthy，端口 `18789` 可访问 |
| Redis Docker | 端口 `6379` 可访问 |
| PostgreSQL Docker | 端口 `5432` 可访问，`work_items` 当前 9 条 |
| agent-tools | 端口 `8787` 可访问，`/health` 正常 |

### 2. OpenClaw 工作区配置

已写入 OpenClaw 容器工作区：

- `/home/node/.openclaw/workspace/skills/feishu-agent-tools/SKILL.md`
- `/home/node/.openclaw/workspace/FEISHU_AGENT_SYSTEM_PROMPT.md`
- `/home/node/.openclaw/workspace/feishu-agent-tools-manifest.json`
- `/home/node/.openclaw/workspace/HEARTBEAT.md`

并在 `/home/node/.openclaw/workspace/TOOLS.md` 追加了 FeishuAgent 工具入口说明。

### 3. agent-tools HTTP 工具

以下工具已通过 HTTP 调用验证：

| 工具 | 结果 |
| --- | --- |
| `summarizeWorkItemHub` | 成功，返回 9 条活跃事项、2 条风险、Base 链接 |
| `queryWorkItems` | 成功，可按 `itemType=risk` 查询 2 条风险事项 |
| `inspectRisks` | 成功，当前无超期/阻塞事项 |
| `syncWorkItemHub` | 成功，投影 9 条事项到 Base 总表 |

### 4. OpenClaw Gateway 端点

已按当前版本支持的配置方式启用：

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  }
}
```

OpenClaw 重启后保持 healthy，说明配置格式被当前 `2026.3.28` 版本接受。

### 5. OpenClaw WebSocket Gateway

用户提供（已脱敏）：

- WebSocket URL：`ws://127.0.0.1:18789`
- Gateway token：`<REDACTED_OPENCLAW_GATEWAY_TOKEN>`

验证结果：

- WebSocket 可以连接。
- 连接后 Gateway 会返回 `connect.challenge`。
- 使用 `client.id = "cli"`、`client.mode = "cli"`、`role = "operator"`、`auth.token = gateway.auth.token` 可完成 `connect` 握手。
- 握手返回 `hello-ok`，可见 Gateway 暴露了 `agents.*`、`tools.*`、`sessions.*`、`cron.*` 等方法。

限制：

- 直接用 Gateway token 进行 RPC 调用时，`agents.list` / `tools.catalog` 返回 `missing scope: operator.read`。
- 通过 `openclaw devices rotate` 生成的 operator token 不能直接作为 `auth.token` 使用，会返回 `gateway token mismatch`。
- 因此直接手写 WebSocket 客户端还需要实现 OpenClaw 设备身份/签名/设备 token 机制。

### 6. OpenClaw CLI Agent

验证结果：

- `openclaw agent --agent main ...` 可以成功运行。
- 原默认模型 `deepseek/deepseek-r1:1.5b` 不存在，已将 OpenClaw 默认模型修正为 `deepseek/deepseek-chat`。
- OpenClaw Agent 已能读取 `FEISHU_AGENT_SYSTEM_PROMPT.md` 与 `skills/feishu-agent-tools/SKILL.md`。
- OpenClaw 容器访问 Windows agent-tools 的正确地址是 `http://172.20.112.1:8787`。
- 已验证自然语言调用：

```text
请使用 feishu-agent-tools 工具总结当前事项中枢...
```

OpenClaw 返回了当前事项中枢概况：

- 活跃事项：9 条
- 风险事项：2 条
- 阻塞事项：0 条
- 并附带 Base 总表链接

这说明当前可用的 OpenClaw 主体接入方式是：

```text
OpenClaw Agent CLI/WebSocket 内部执行
  -> 读取 feishu-agent-tools skill
  -> 通过 HTTP 调用 agent-tools
  -> 返回自然语言总结
```

### 7. OpenClaw 连接封装（历史记录，已过期）

以下内容是早期 HTTP 路径验证记录，当前已过期：

1. 优先尝试 `/v1/chat/completions`
2. 再尝试 `/v1/responses`
3. 再尝试 `/v1/gateway/messages`
4. 全部不可用时回退 `LLM_BASE_URL` 当前配置的 DeepSeek API

当前实际结果：

```json
{
  "content": "OK",
  "provider": "llm-fallback"
}
```

当前事实：`src/domain/openclaw-client.ts` 已改为只通过 OpenClaw WebSocket Gateway + device auth 调用 `agent` RPC，不再使用 HTTP `/v1/*` 或 DeepSeek fallback。

## 当前阻塞点

### 1. OpenClaw HTTP `/v1/*` token scope（不再作为主线）

使用 `gateway.auth.token` 调用 `/v1/models`、`/v1/chat/completions`、`/v1/responses` 时返回：

```json
{
  "ok": false,
  "error": {
    "type": "forbidden",
    "message": "missing scope: operator.read/operator.write"
  }
}
```

尝试通过 `openclaw devices approve/rotate` 生成 operator token 后，HTTP Bearer 调用返回：

```json
{
  "error": {
    "message": "Unauthorized",
    "type": "unauthorized"
  }
}
```

判断：该问题不再阻塞当前主线。当前主线使用 WebSocket Gateway + device auth；HTTP `/v1/*` 可作为后续增强研究，但不应作为 FeishuAgent 的 LLM / Agent 主路径。

### 2. OpenClaw 自动选择工具已初步验证，但仍需飞书端验证

OpenClaw CLI Agent 已能读取工具说明，并在明确提示下调用 `agent-tools`。

尚未验证：

- 飞书消息入口触发 OpenClaw 后是否会自动调用该工具。
- OpenClaw 在不显式给出 URL/token 的自然语言情况下，是否稳定选择 `feishu-agent-tools` skill。

### 3. 真实会议和真实群聊待补充

当前项目使用模拟会议数据验证：

- 9 条 WorkItem
- 2 条风险
- 6 条 todo
- 1 条 decision

真实验证仍需要：

- 真实 meetingId
- 真实 chatId
- 真实负责人 open_id
- 可发送卡片的测试群

## 下一步建议

1. 在飞书中向 OpenClaw 发自然语言指令，验证它是否稳定调用 `feishu-agent-tools`。
2. 提供一个测试群 chat_id，验证风险卡片/周报卡片主动推送。
3. 提供真实 meetingId，验证 `extractMeetingItems` 的真实会议链路。
4. 若飞书端自然语言入口不稳定，则下一步实现一个 OpenClaw Skill 命令脚本，通过 `curl` 显式调用 `agent-tools`。
5. HTTP `/v1/*` 可继续作为增强项排查，但当前不阻塞项目主链路。
