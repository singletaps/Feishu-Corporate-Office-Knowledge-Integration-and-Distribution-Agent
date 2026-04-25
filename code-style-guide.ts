/**
 * ============================================================
 * 项目代码规范示例
 * ============================================================
 *
 * 本文件是可编译的 TypeScript，同时充当代码规范文档。
 * 后续所有模块代码应遵循本文件的风格约定。
 *
 * 核心原则：
 *   1. 简单直接，不过度设计
 *   2. 不做防御性编程，不到处 try-catch
 *   3. 多留日志，少写注释
 *   4. 让类型系统承担校验职责
 */

// ============================================================
// 一、目录结构约定
// ============================================================
//
// src/
// ├── trigger/              事件接入
// │   ├── normalizer.ts     事件标准化
// │   └── dispatcher.ts     工作流派发
// ├── workflow/              Trigger.dev 工作流定义
// │   ├── post-meeting.ts
// │   ├── pre-meeting.ts
// │   ├── risk-inspection.ts
// │   └── card-callback.ts
// ├── domain/                核心业务逻辑
// │   ├── work-item.ts      事项管理
// │   ├── asset.ts          知识资产
// │   ├── artifact.ts       知识产物
// │   ├── llm.ts            LLM 调用
// │   └── prompts/          Prompt 模板文件
// │       ├── extract-work-items.txt
// │       ├── reconcile-items.txt
// │       └── generate-brief.txt
// ├── integration/           飞书 API 适配
// │   ├── meeting.ts
// │   ├── calendar.ts
// │   ├── task.ts
// │   ├── message.ts
// │   ├── doc.ts
// │   ├── base.ts
// │   └── mail.ts
// ├── touchpoint/            卡片渲染与输出
// │   ├── card.ts            卡片发送（含 IO）
// │   ├── render.ts          卡片 JSON 生成（纯函数）
// │   └── cli.ts             CLI 格式化
// ├── evaluation/            评测与观测
// │   ├── logger.ts          日志
// │   ├── execution.ts       执行记录
// │   ├── metrics.ts         指标
// │   └── eval-runner.ts     评测执行
// ├── shared/                公共代码
// │   ├── types.ts           所有共享类型定义
// │   ├── db.ts              数据库客户端
// │   ├── redis.ts           Redis 客户端
// │   ├── config.ts          环境配置
// │   └── errors.ts          自定义错误类型
// └── index.ts               应用入口
//
// 文件命名：kebab-case（如 work-item.ts, risk-inspection.ts）
// 一个文件做一件事，超过 300 行考虑拆分

// ============================================================
// 二、命名规范
// ============================================================

// --- 变量和函数：camelCase ---
const meetingId = "m_abc123"
const isOverdue = true

async function getMinutes(meetingId: string) {
  return { meetingId, transcript: "" }
}

// --- 类型和接口：PascalCase，不加 I 前缀 ---
interface WorkItem {
  id: string
  title: string
  itemType: ItemType
  status: ItemStatus
}

// --- 枚举用 const object + 同名 type，不用 enum 关键字 ---
// 原因：enum 在运行时生成反向映射，增加包体积且与 tree-shaking 不兼容
const ItemType = {
  Todo: "todo",
  Decision: "decision",
  Risk: "risk",
  Blocker: "blocker",
} as const
type ItemType = (typeof ItemType)[keyof typeof ItemType]

const ItemStatus = {
  New: "new",
  PendingReview: "pending_review",
  Active: "active",
  Blocked: "blocked",
  Done: "done",
  Closed: "closed",
} as const
type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]

// --- 常量：UPPER_SNAKE_CASE 仅用于真正的全局配置常量 ---
const MAX_LLM_RETRIES = 1
const LLM_TIMEOUT_MS = 30_000
const IDEMPOTENCY_TTL_SECONDS = 3600

// --- 数据库列名映射：代码中 camelCase，SQL 中 snake_case ---
// ORM 或查询层负责转换，业务代码只看到 camelCase

// ============================================================
// 三、函数风格
// ============================================================

// 优先用独立函数，不用 class。class 只在需要管理内部状态时使用。
// 函数签名要明确：参数类型、返回类型都显式标注。

// 好：独立的 async 函数，参数和返回类型清晰
async function extractWorkItems(
  content: string,
  participants: FeishuUser[],
  originChannel: OriginChannel,
  originContextId: string,
): Promise<ExtractedWorkItem[]> {
  log.info("extracting work items", { originChannel, originContextId, contentLength: content.length })

  const result = await callOpenClaw("extract-work-items", {
    content,
    participantNames: participants.map((p) => p.name),
  }, extractedWorkItemSchema)

  log.info("extraction complete", { count: result.data.length, tokenUsage: result.tokenUsage })
  return result.data
}

// 坏：不要这样写
// class WorkItemExtractor {
//   private content: string
//   constructor(content: string) { this.content = content }
//   async extract() { ... }
// }

// ============================================================
// 四、错误处理 — 不要防御性编程
// ============================================================

// 核心原则：
// - 不在每个函数里 try-catch
// - 让错误自然冒泡到 workflow 层统一处理
// - workflow 层的 Trigger.dev task 自带重试机制
// - 只在需要「转译错误」或「做清理」时才 catch

// 好：让错误冒泡
async function createFeishuTask(params: CreateTaskParams): Promise<FeishuTaskResult> {
  log.info("creating feishu task", { title: params.title, owner: params.ownerOpenId })

  const result = await larkCli("task", "create", {
    summary: params.title,
    due: params.dueAt?.toISOString(),
    description: params.description,
  })

  log.info("feishu task created", { taskId: result.task_id })
  return { taskId: result.task_id, url: result.url }
}
// 如果 larkCli 抛错，错误会冒泡到 workflow 层，Trigger.dev 会自动重试

// 好：只在需要转译时 catch
async function callOpenClaw<T>(
  templateName: string,
  variables: Record<string, unknown>,
  schema: ZodSchema<T>,
): Promise<{ data: T; tokenUsage: TokenUsage }> {
  const prompt = loadPromptTemplate(templateName, variables)
  log.info("calling openclaw", { templateName, variableKeys: Object.keys(variables) })

  const raw = await openClawClient.chat(prompt)
  log.debug("openclaw raw response", { templateName, responseLength: raw.content.length })

  const parsed = JSON.parse(raw.content)
  const validated = schema.safeParse(parsed)

  if (!validated.success) {
    log.warn("schema validation failed, retrying", { templateName, errors: validated.error.issues })
    // 重试一次
    const retryRaw = await openClawClient.chat(prompt)
    const retryParsed = JSON.parse(retryRaw.content)
    const retryValidated = schema.parse(retryParsed) // 第二次直接 throw
    return { data: retryValidated, tokenUsage: mergeTokenUsage(raw.usage, retryRaw.usage) }
  }

  return { data: validated.data, tokenUsage: raw.usage }
}

// 坏：不要这样写
// async function createFeishuTask(params) {
//   try {
//     const result = await larkCli(...)
//     return result
//   } catch (error) {
//     console.error("Failed to create task", error)
//     throw error  // catch 了又 throw，毫无意义
//   }
// }

// ============================================================
// 五、自定义错误类型
// ============================================================

// 放在 src/shared/errors.ts。只定义少量业务错误类型，不要泛化。

class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
  }
}

class LLMExtractionError extends AppError {
  constructor(templateName: string, reason: string) {
    super(`LLM extraction failed: ${reason}`, "LLM_EXTRACTION_FAILED", { templateName, reason })
    this.name = "LLMExtractionError"
  }
}

class FeishuAPIError extends AppError {
  constructor(service: string, method: string, statusCode: number, body: unknown) {
    super(`Feishu API error: ${service}.${method} returned ${statusCode}`, "FEISHU_API_ERROR", {
      service,
      method,
      statusCode,
      body,
    })
    this.name = "FeishuAPIError"
  }
}

class ItemNotFoundError extends AppError {
  constructor(workItemId: string) {
    super(`WorkItem not found: ${workItemId}`, "ITEM_NOT_FOUND", { workItemId })
    this.name = "ItemNotFoundError"
  }
}

// ============================================================
// 六、日志规范
// ============================================================

// 使用项目统一的 log 对象，不用 console.log。
// 每个关键操作的入口和出口各留一条日志。
// 日志要带结构化上下文（context），不要拼字符串。

// log 的实现在 src/evaluation/logger.ts，这里展示用法：

const log = {
  info(msg: string, context?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "info", msg, ...context, ts: new Date().toISOString() }))
  },
  warn(msg: string, context?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "warn", msg, ...context, ts: new Date().toISOString() }))
  },
  error(msg: string, context?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "error", msg, ...context, ts: new Date().toISOString() }))
  },
  debug(msg: string, context?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(JSON.stringify({ level: "debug", msg, ...context, ts: new Date().toISOString() }))
    }
  },
}

// 好：入口 + 出口，带结构化上下文
async function reconcileAndSave(
  extracted: ExtractedWorkItem[],
  originChannel: OriginChannel,
  originContextId: string,
): Promise<WorkItem[]> {
  log.info("reconciling work items", { count: extracted.length, originChannel, originContextId })

  const existing = await db.query("SELECT * FROM work_items WHERE origin_context_id = $1", [originContextId])
  log.info("found existing items", { existingCount: existing.length })

  const saved: WorkItem[] = []
  for (const item of extracted) {
    const match = findMatchingItem(existing, item)
    if (match) {
      log.info("merging with existing item", { newTitle: item.title, existingId: match.id })
      saved.push(await mergeItem(match, item))
    } else {
      log.info("creating new item", { title: item.title, itemType: item.itemType })
      saved.push(await insertItem(item, originChannel, originContextId))
    }
  }

  log.info("reconciliation complete", { savedCount: saved.length, newCount: saved.filter((s) => !s.lastDetectedAt).length })
  return saved
}

// 坏：拼字符串、信息量不足
// console.log("Processing " + items.length + " items")
// console.log("Done")

// ============================================================
// 七、数据库查询风格
// ============================================================

// 使用参数化查询，不拼 SQL 字符串。
// 查询结果做 camelCase 转换。
// 复杂查询写 SQL，不用 ORM 的链式 API 拼接复杂条件。

// db 客户端示例（src/shared/db.ts 提供）
interface DbClient {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>
}

// 好：直接写 SQL，参数化
async function findOverdueItems(db: DbClient): Promise<WorkItem[]> {
  return db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE status = 'active' AND due_at < now() AND deleted_at IS NULL
     ORDER BY due_at ASC`,
  )
}

// 好：INSERT 也用参数化
async function insertItem(db: DbClient, item: ExtractedWorkItem, channel: string, contextId: string): Promise<WorkItem> {
  const result = await db.query<WorkItem>(
    `INSERT INTO work_items (title, item_type, status, priority, owner_user_id, due_at,
       confidence_score, need_human_confirm, origin_channel, origin_context_id, metadata, first_detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     RETURNING *`,
    [
      item.title, item.itemType, "new", item.priority, null, item.dueAt,
      item.confidenceScore, item.confidenceScore < 0.6, channel, contextId,
      JSON.stringify(item.metadata),
    ],
  )
  return result[0]
}

// ============================================================
// 八、配置管理
// ============================================================

// 所有配置从环境变量读取，集中在 src/shared/config.ts。
// 应用启动时一次性读取，不要在业务代码中到处 process.env。

interface AppConfig {
  database: { url: string; poolSize: number }
  redis: { url: string }
  feishu: { appId: string; appSecret: string }
  openclaw: { apiKey: string; model: string; maxRetries: number; timeoutMs: number }
  logLevel: "debug" | "info" | "warn" | "error"
}

function loadConfig(): AppConfig {
  return {
    database: {
      url: requireEnv("DATABASE_URL"),
      poolSize: Number(process.env.DB_POOL_SIZE ?? "10"),
    },
    redis: {
      url: requireEnv("REDIS_URL"),
    },
    feishu: {
      appId: requireEnv("FEISHU_APP_ID"),
      appSecret: requireEnv("FEISHU_APP_SECRET"),
    },
    openclaw: {
      apiKey: requireEnv("OPENCLAW_API_KEY"),
      model: process.env.OPENCLAW_MODEL ?? "doubao-2.0-pro",
      maxRetries: MAX_LLM_RETRIES,
      timeoutMs: LLM_TIMEOUT_MS,
    },
    logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

// ============================================================
// 九、导出风格
// ============================================================

// 每个模块文件导出独立函数，不导出 default。
// 模块入口文件（如 integration/index.ts）做桶导出。

// src/integration/meeting.ts
export async function getMinutesFn(meetingId: string): Promise<MeetingMinutes> {
  log.info("fetching meeting minutes", { meetingId })
  // ...
  return {} as MeetingMinutes
}

// src/integration/index.ts
// export { getMinutes, getMeetingDetail } from "./meeting"
// export { getEventDetail, getUpcomingEvents } from "./calendar"
// export { createFeishuTask, updateFeishuTask } from "./task"
// ...

// 在 workflow 中使用：
// import { getMinutes } from "@/integration"
// import { extractWorkItems, reconcileAndSave } from "@/domain"
// import { sendPostMeetingConfirmCard } from "@/touchpoint"

// ============================================================
// 十、Prompt 模板文件规范
// ============================================================

// Prompt 存为纯文本文件放在 src/domain/prompts/ 下。
// 文件名与 callOpenClaw 的 templateName 一致。
// 变量用 {{variableName}} 标记。
// 文件内容示例（extract-work-items.txt）：
//
// System:
// 你是一个会议纪要分析助手。从以下会议纪要中抽取所有事项。
// 每个事项必须包含以下字段，以 JSON 数组格式返回。
//
// 输出格式：
// [
//   {
//     "title": "事项标题",
//     "itemType": "todo" | "decision" | "risk" | "blocker",
//     "ownerName": "负责人姓名或 null",
//     "dueAt": "YYYY-MM-DD 或 null",
//     "priority": "low" | "medium" | "high" | "critical" | null,
//     "confidenceScore": 0.0-1.0
//   }
// ]
//
// 参会人列表：{{participantNames}}
//
// User:
// {{content}}

// ============================================================
// 以下是让本文件可通过 TypeScript 编译的类型占位
// ============================================================

interface FeishuUser { openId: string; name: string; email?: string }
interface ExtractedWorkItem {
  title: string; itemType: ItemType; ownerName: string | null; dueAt: string | null
  priority: "low" | "medium" | "high" | "critical" | null; confidenceScore: number
  metadata: Record<string, unknown>
}
type OriginChannel = "meeting" | "minutes" | "doc" | "wiki" | "im" | "task" | "mail"
interface MeetingMinutes { meetingId: string; transcript: string; participants: FeishuUser[] }
interface CreateTaskParams { title: string; ownerOpenId: string | null; dueAt: Date | null; description: string | null }
interface FeishuTaskResult { taskId: string; url: string }
interface TokenUsage { input: number; output: number }
interface ZodSchema<T> { parse(data: unknown): T; safeParse(data: unknown): { success: boolean; data?: T; error?: { issues: unknown[] } } }
const extractedWorkItemSchema = {} as ZodSchema<ExtractedWorkItem[]>
const openClawClient = { chat: async (_prompt: string): Promise<{ content: string; usage: TokenUsage }> => ({ content: "", usage: { input: 0, output: 0 } }) }
function loadPromptTemplate(_name: string, _vars: Record<string, unknown>): string { return "" }
function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage { return { input: a.input + b.input, output: a.output + b.output } }
function larkCli(_service: string, _method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> { return Promise.resolve({}) }
const db = { query: async <T>(_sql: string, _params?: unknown[]): Promise<T[]> => [], queryOne: async <T>(_sql: string, _params?: unknown[]): Promise<T | null> => null, execute: async (_sql: string, _params?: unknown[]) => ({ rowCount: 0 }) }
function findMatchingItem(_existing: WorkItem[], _item: ExtractedWorkItem): WorkItem | null { return null }
async function mergeItem(_existing: WorkItem, _item: ExtractedWorkItem): Promise<WorkItem> { return {} as WorkItem }

export {}
