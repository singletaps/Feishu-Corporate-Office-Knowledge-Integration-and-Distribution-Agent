# FeishuAgent

FeishuAgent 是一个面向飞书办公场景的主动知识服务 Agent。项目目标不是做一个简单聊天 Bot，而是用 **OpenClaw + lark-cli + 飞书开放能力** 将会议、文档、消息、任务等分散信息转化为可追踪、可分派、可验证的高密度知识产物。

当前主线是：

- `D`：团队待办中枢与进展自动对账。
- `B`：会议与项目全链路伴侣，作为首个高频入口。
- `A`：周期性管理洞察。
- `C`：CLI / 开发者即时知识推送。

## 当前阶段

当前处于早期 MVP 阶段。已实现的能力只是最终系统的一小部分，不能把当前 MVP 范围误认为最终目标。

已具备：

- PostgreSQL / Redis 基础状态存储。
- Trigger.dev 后台工作流骨架。
- lark-cli 会议、任务、消息、Base 适配。
- 会后会议纪要抽取 WorkItem。
- WorkItem 入库、飞书任务创建、Base 总表投影。
- OpenClaw WebSocket Gateway 调用路径。
- `agent-tools` HTTP 工具服务，供 OpenClaw Skill 调用项目能力。
- 基础评测报告生成脚本。

部分具备但未完整闭环：

- 会后确认卡片发送已具备基础渲染和发送能力，但卡片按钮回调尚未完整处理。
- 风险巡检和周报工作流已有骨架，但需要真实飞书数据验证。
- OpenClaw 已可作为 Agent 主体调用工具，但飞书端自然语言入口仍需验证稳定性。

尚未完成：

- 会前背景卡片链路。
- 文档、IM、邮件、任务变更等多源事项接入。
- 卡片确认 / 驳回 / 修改后的状态闭环。
- 真实会议样本人工标注与 Precision / Recall / F1 评测。
- 用户接受度指标，如卡片确认率、任务认领率、处理耗时下降。
- OpenTelemetry / Langfuse 等生产级观测能力。

## 架构定位

OpenClaw 应是项目的 Agent 主体：

- OpenClaw 负责理解用户意图、选择场景、调用工具、组织自然语言反馈。
- Node.js 服务负责确定性业务内核，包括事项状态机、数据库、幂等、审计、对账、评测。
- Trigger.dev 主要负责后台确定性工作流，如定时对账、风险巡检、补偿任务和可重复执行的调度。
- lark-cli / 飞书 OpenAPI 负责读取和写回飞书资源。

当前 OpenClaw LLM 调用路径是 WebSocket Gateway，不再依赖 OpenClaw HTTP `/v1/*` fallback。`agent-tools` HTTP 服务仍然保留，因为它是 OpenClaw Skill 调用 FeishuAgent 业务工具的本地服务接口。

## 常用命令

```bash
npm run build
npm run dev
npm run dev:tools
npm run eval:report
```

本地飞书端联调建议使用稳定单实例：

```bash
npm run build
npm start
```

`npm run dev` 使用 `tsx watch`，适合开发代码，但在 Windows 上热重启时可能留下旧的 `src/index.ts` 或 `lark-cli event +subscribe` 子进程。做飞书消息链路验证时，如果刚改过监听代码，优先清理残留进程后用 `npm start` 启动。

## 飞书事件订阅排障

飞书 IM 消息无响应、`/help` 或 `/add` 偶发无输出时，优先检查是否存在多个本地事件消费者。`lark-cli event +subscribe` 对同一个 app 只应有一个消费者；多个消费者会导致消息被分流，当前服务日志看不到 `raw lark event received`。

本地监听默认只订阅已真实验证过的 IM 和卡片事件：

```text
im.message.receive_v1,card.action.trigger
```

如需启用文档、Wiki、任务或邮件事件，先在飞书开放平台确认应用已订阅并授权对应 EventKey，再通过环境变量扩展本地消费者。EventKey 不确定时不要改代码，直接配置别名：

```powershell
$env:FEISHU_EXTRA_EVENT_TYPES="doc_update,wiki_update,task_update,mail_received"
$env:FEISHU_DOC_EVENT_TYPES="doc_update,<真实文档 EventKey>"
$env:FEISHU_WIKI_EVENT_TYPES="wiki_update,<真实 Wiki EventKey>"
$env:FEISHU_TASK_EVENT_TYPES="task_update,<真实任务 EventKey>"
$env:FEISHU_MAIL_EVENT_TYPES="mail_received,<真实邮件 EventKey>"
npm start
```

也可以用 `FEISHU_EVENT_TYPES` 覆盖完整订阅列表。`FEISHU_DOC_EVENT_TYPES` / `FEISHU_WIKI_EVENT_TYPES` / `FEISHU_TASK_EVENT_TYPES` / `FEISHU_MAIL_EVENT_TYPES` 用于把真实 EventKey 映射到已有 adapter，避免 lark-cli EventKey 与本地短名不一致时事件被忽略。

真实文档或 Wiki 拉取可先只验证 source pull，不入库、不写 Base：

```powershell
$env:FEISHU_SOURCE_PULL_TARGET="<doc/wiki token 或 URL>"
npm run validate:source-pull:real -- doc
npm run validate:source-pull:real -- wiki
```

常见日志：

```text
another event +subscribe instance is already running for app ...
Only one subscriber per app is allowed to prevent competing consumers.
listen EADDRINUSE: address already in use :::8787
```

标准恢复步骤（PowerShell）：

```powershell
# 1. 查看 8787 是否被旧服务占用
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess

# 2. 查看所有本地飞书事件订阅消费者
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'event\s+\+subscribe|event \+subscribe|lark-cli.*subscribe' } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine

# 3. 关闭旧的 src/index.ts、tsx watch、lark-cli event +subscribe 进程
Stop-Process -Id <pid1>,<pid2> -Force

# 4. 确认端口和订阅进程已清空后，稳定启动单实例
npm run build
npm start
```

不要把 `--force` 作为常规解决方案。`--force` 只能抢占订阅检查，不能消除旧消费者；在 `tsx watch` 热重启或进程异常退出时，反而容易留下多个本地 `lark-cli.exe event +subscribe`，导致飞书消息继续分流。

## 飞书机器人与 Hub 运行约束

方向 D 的 IM 触达默认使用应用机器人身份：

- 机器人必须加入目标群，且应用具备发送文本消息、发送交互卡片、更新卡片所需 scope。
- `/help`、`/hub`、`/select-hub <hubId>`、会后确认卡片、风险卡片和 OpenClaw 问询回复都应显示为应用机器人发送。
- Base 表创建、字段管理和记录写入暂时仍按多维表格权限独立验证，不随 IM 出站一刀切切换为 bot。
- 多 Hub 首期会将现有 `FEISHU_BASE_TOKEN` / `FEISHU_BASE_TABLE_ID` 迁入默认 `legacy` Hub；后续团队 Hub 和个人 Hub 通过 `item_hubs` 与 `work_item_hub_projections` 管理投影。

## 重要文档

- `FeishuProject.md`：赛题原文。
- `FeishuAgent 阶段任务规划.md`：当前阶段与后续阶段任务划分。
- `阶段3审阅设计文档.md`：阶段 3 文档收敛、实现差距和下一步目标。
- `FeishuAgent MVP 审阅整改计划.md`：MVP 审阅与整改基线，后续以阶段 3 文档更新当前状态。
- `概要设计说明书+FeishuAPI.md`：场景定义、需求范围、飞书能力映射和评测方案。
- `架构设计说明书.md`：最终系统架构设计。
- `对象模型与模块设计说明.md`：对象模型和数据库逻辑设计。
- `OpenClaw主体化方案.md`：OpenClaw 作为 Agent 主体的设计说明。
- `WorkItem Hub 归属边界条件设计.md`：多 Hub 归属、投影、触达和 OpenClaw 判定边界。
- `docs/archive/`：历史审阅、过程验证和周报类材料，默认不作为当前事实入口。

## 安全提示

不要提交 `.env`、OpenClaw Gateway token、设备 token、真实飞书凭据或包含真实组织数据的验证记录。过程性验证文档应脱敏后归档。
