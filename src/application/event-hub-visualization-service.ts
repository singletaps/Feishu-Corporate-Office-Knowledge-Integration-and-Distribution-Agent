import { randomUUID } from "node:crypto"
import { unlinkSync, writeFileSync } from "node:fs"
import { config } from "../shared/config.js"
import { larkCli } from "../integration/lark-cli.js"

const EVENT_HUB_TABLE_NAME = "事件中枢"
const EVENT_KEY_FIELD = "事件键"

export interface EventHubRoute {
  eventKey: string
  eventType: string
  sourceType: "meeting" | "card" | "im" | "doc" | "wiki" | "task" | "mail"
  triggerCommand: string
  workflowName: string
  status: "启用" | "待接入" | "需配置"
  completed: boolean
  requiresPull: boolean
  requiresHub: boolean
  openclawRoute: "不进入" | "按需进入" | "进入"
  failureStrategy: string
  userAction: string
  description: string
}

export interface EventHubViewResult {
  baseToken: string
  tableId: string
  tableName: string
  routeCount: number
  recordIds: string[]
  baseUrl: string
}

export interface CompleteEventHubTaskResult {
  tableId: string
  eventKey: string
  recordId: string
  completed: boolean
  status: string
}

export function getEventHubRoutes(): EventHubRoute[] {
  return [
    {
      eventKey: "meeting_start",
      eventType: "vc.meeting.meeting_started_v1 / meeting_start",
      sourceType: "meeting",
      triggerCommand: "会议开始事件",
      workflowName: "pre-meeting-brief",
      status: "启用",
      completed: true,
      requiresPull: true,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "缺 meeting_id 时跳过并记录日志；拉取失败交由 workflow 重试。",
      userAction: "会议前检查背景卡片是否已生成并推送",
      description: "会议开始前汇总相关 WorkItem，生成会前背景卡片。",
    },
    {
      eventKey: "meeting_end",
      eventType: "vc.meeting.meeting_ended_v1 / meeting_end",
      sourceType: "meeting",
      triggerCommand: "会议结束事件",
      workflowName: "post-meeting-extraction",
      status: "启用",
      completed: true,
      requiresPull: true,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "缺 meeting_id 时跳过并记录日志；会议纪要拉取与抽取失败交由 workflow 重试。",
      userAction: "会后确认事项、补充负责人并推动任务创建",
      description: "会议结束后拉取纪要，抽取事项并投影到事项中枢。",
    },
    {
      eventKey: "card_callback",
      eventType: "card.action.trigger / card_callback",
      sourceType: "card",
      triggerCommand: "卡片按钮回调",
      workflowName: "card-callback",
      status: "启用",
      completed: true,
      requiresPull: false,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "回调失败通过卡片 toast 返回明确错误，并记录应用日志。",
      userAction: "在卡片中确认、驳回或修改事项",
      description: "处理用户对确认卡片和风险卡片的交互。",
    },
    {
      eventKey: "im_message",
      eventType: "im.message.receive_v1 / im_message",
      sourceType: "im",
      triggerCommand: "群消息关键词或消息事件",
      workflowName: "source-ingestion",
      status: "启用",
      completed: true,
      requiresPull: false,
      requiresHub: true,
      openclawRoute: "按需进入",
      failureStrategy: "普通消息按关键词摄入；/help 直接回复；@机器人问询进入 OpenClaw；无关消息忽略。",
      userAction: "检查群消息是否被识别为事项来源",
      description: "从群消息正文抽取 Todo、风险、阻塞和决策，并支持可控入站分流。",
    },
    {
      eventKey: "doc_update",
      eventType: "doc_update",
      sourceType: "doc",
      triggerCommand: "文档更新/命令触发",
      workflowName: "source-ingestion",
      status: "待接入",
      completed: false,
      requiresPull: true,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "事件仅记录待拉取状态；后续需按 doc_token 拉取正文后再摄入。",
      userAction: "选择文档内容并触发事项抽取",
      description: "待补正文拉取后，从飞书文档内容中抽取事项并保留文档证据。",
    },
    {
      eventKey: "wiki_update",
      eventType: "wiki_update",
      sourceType: "wiki",
      triggerCommand: "Wiki 更新/命令触发",
      workflowName: "source-ingestion",
      status: "待接入",
      completed: false,
      requiresPull: true,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "事件仅记录待拉取状态；后续需按 wiki token 拉取正文后再摄入。",
      userAction: "选择 Wiki 页面并触发事项抽取",
      description: "待补正文拉取后，从 Wiki 页面内容中抽取事项并保留 Wiki 证据。",
    },
    {
      eventKey: "task_update",
      eventType: "task_update",
      sourceType: "task",
      triggerCommand: "飞书任务状态变化",
      workflowName: "source-ingestion / item-reconciliation",
      status: "需配置",
      completed: false,
      requiresPull: true,
      requiresHub: false,
      openclawRoute: "不进入",
      failureStrategy: "首期不直接摄入正文；作为单任务状态同步或全量对账触发。",
      userAction: "同步飞书任务进展，核对状态是否回写",
      description: "待配置任务变更事件或轮询对账后，同步外部任务状态。",
    },
    {
      eventKey: "mail_received",
      eventType: "mail_received",
      sourceType: "mail",
      triggerCommand: "邮件到达/命令触发",
      workflowName: "source-ingestion",
      status: "待接入",
      completed: false,
      requiresPull: true,
      requiresHub: true,
      openclawRoute: "不进入",
      failureStrategy: "事件仅记录待拉取状态；后续需拉取邮件正文、去重后再摄入。",
      userAction: "选择邮件正文并触发事项抽取",
      description: "待补邮件正文拉取后，从邮件中抽取事项并保留邮件证据。",
    },
  ]
}

export function renderEventHubMermaid(): string {
  const routes = getEventHubRoutes()
  return [
    "flowchart LR",
    ...routes.map(
      (route) =>
        `  ${sanitizeMermaidId(route.eventKey)}["${route.eventType}"] --> ${sanitizeMermaidId(route.workflowName)}["${route.workflowName}"]`,
    ),
  ].join("\n")
}

export async function publishEventHubView(): Promise<EventHubViewResult> {
  const tableId = await ensureEventHubTable()
  await ensureEventHubFields(tableId)

  const recordIds: string[] = []
  for (const route of getEventHubRoutes()) {
    const recordId = await upsertEventRoute(tableId, route)
    recordIds.push(recordId)
  }

  return {
    baseToken: config.feishu.baseToken,
    tableId,
    tableName: EVENT_HUB_TABLE_NAME,
    routeCount: recordIds.length,
    recordIds,
    baseUrl: config.feishu.baseUrl,
  }
}

export async function completeEventHubTask(eventKey: string, completed = true): Promise<CompleteEventHubTaskResult> {
  const tableId = await ensureEventHubTable()
  await ensureEventHubFields(tableId)
  const recordId = await findEventHubRecordId(tableId, eventKey)
  if (!recordId) {
    throw new Error(`Event hub route not found in Feishu Base: ${eventKey}`)
  }

  const route = getEventHubRoutes().find((item) => item.eventKey === eventKey)
  const status = completed ? "启用" : (route?.status ?? "启用")
  await writeEventHubRecord(tableId, toBaseFields({
    ...(route ?? fallbackRoute(eventKey)),
    completed,
    status,
  }), recordId)

  return { tableId, eventKey, recordId, completed, status }
}

async function ensureEventHubTable(): Promise<string> {
  const existing = await findEventHubTableId()
  if (existing) return existing

  const response = await larkCli([
    "base",
    "+table-create",
    "--as",
    "user",
    "--base-token",
    config.feishu.baseToken,
    "--name",
    EVENT_HUB_TABLE_NAME,
    "--fields",
    JSON.stringify([
      { type: "text", name: EVENT_KEY_FIELD, style: { type: "plain" } },
      { type: "text", name: "事件类型", style: { type: "plain" } },
      { type: "select", name: "来源类型", multiple: false, options: selectOptions(["meeting", "card", "im", "doc", "wiki", "task", "mail"]) },
      { type: "text", name: "输入/命令", style: { type: "plain" } },
      { type: "text", name: "目标工作流", style: { type: "plain" } },
      { type: "select", name: "中枢状态", multiple: false, options: selectOptions(["启用", "待接入", "需配置"]) },
      { type: "checkbox", name: "已完成" },
      { type: "checkbox", name: "需异步拉取" },
      { type: "checkbox", name: "需Hub上下文" },
      { type: "select", name: "OpenClaw路由", multiple: false, options: selectOptions(["不进入", "按需进入", "进入"]) },
      { type: "text", name: "失败处理策略", style: { type: "plain" } },
      { type: "text", name: "用户操作", style: { type: "plain" } },
      { type: "text", name: "说明", style: { type: "plain" } },
      { type: "datetime", name: "最后同步时间", style: { format: "yyyy-MM-dd HH:mm" } },
    ]),
  ]) as { data?: { table?: { table_id?: string; id?: string } }; table?: { table_id?: string; id?: string } } | null

  const table = response?.data?.table ?? response?.table
  return table?.table_id ?? table?.id ?? await requireEventHubTableId()
}

async function ensureEventHubFields(tableId: string): Promise<void> {
  const fields = await listFieldNames(tableId)
  const requiredFields = [
    { type: "text", name: EVENT_KEY_FIELD, style: { type: "plain" } },
    { type: "text", name: "事件类型", style: { type: "plain" } },
    { type: "select", name: "来源类型", multiple: false, options: selectOptions(["meeting", "card", "im", "doc", "wiki", "task", "mail"]) },
    { type: "text", name: "输入/命令", style: { type: "plain" } },
    { type: "text", name: "目标工作流", style: { type: "plain" } },
    { type: "select", name: "中枢状态", multiple: false, options: selectOptions(["启用", "待接入", "需配置"]) },
    { type: "checkbox", name: "已完成" },
    { type: "checkbox", name: "需异步拉取" },
    { type: "checkbox", name: "需Hub上下文" },
    { type: "select", name: "OpenClaw路由", multiple: false, options: selectOptions(["不进入", "按需进入", "进入"]) },
    { type: "text", name: "失败处理策略", style: { type: "plain" } },
    { type: "text", name: "用户操作", style: { type: "plain" } },
    { type: "text", name: "说明", style: { type: "plain" } },
    { type: "datetime", name: "最后同步时间", style: { format: "yyyy-MM-dd HH:mm" } },
  ]

  for (const field of requiredFields) {
    if (fields.has(field.name)) continue
    await larkCli([
      "base",
      "+field-create",
      "--as",
      "user",
      "--base-token",
      config.feishu.baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify(field),
    ])
  }
}

async function upsertEventRoute(tableId: string, route: EventHubRoute): Promise<string> {
  const recordId = await findEventHubRecordId(tableId, route.eventKey)
  return writeEventHubRecord(tableId, toBaseFields(route), recordId)
}

async function writeEventHubRecord(
  tableId: string,
  fields: Record<string, unknown>,
  recordId?: string | null,
): Promise<string> {
  const jsonFile = writeBaseJsonFile(fields)
  const args = [
    "base",
    "+record-upsert",
    "--as",
    "user",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--json",
    jsonFile,
  ]
  if (recordId) {
    args.push("--record-id", recordId)
  }

  try {
    const response = await larkCli(args) as {
      data?: { record?: { record_id?: string; id?: string } }
      record?: { record_id?: string; id?: string }
    } | null
    const record = response?.data?.record ?? response?.record
    return record?.record_id ?? record?.id ?? recordId ?? await requireEventHubRecordId(tableId, String(fields[EVENT_KEY_FIELD]))
  } finally {
    unlinkSync(jsonFile.slice(1))
  }
}

async function findEventHubTableId(): Promise<string | null> {
  const response = await larkCli([
    "base",
    "+table-list",
    "--as",
    "user",
    "--base-token",
    config.feishu.baseToken,
    "--limit",
    "100",
  ]) as { data?: { tables?: Array<{ id?: string; name?: string }>; items?: Array<{ table_id?: string; table_name?: string; name?: string }> } } | null

  const tables: Array<{ id?: string; table_id?: string; name?: string; table_name?: string }> =
    response?.data?.tables ?? response?.data?.items ?? []
  const table = tables.find((item) => item.table_name === EVENT_HUB_TABLE_NAME || item.name === EVENT_HUB_TABLE_NAME)
  return table?.table_id ?? table?.id ?? null
}

async function requireEventHubTableId(): Promise<string> {
  const tableId = await findEventHubTableId()
  if (!tableId) throw new Error("Failed to create or locate Feishu Base event hub table")
  return tableId
}

async function listFieldNames(tableId: string): Promise<Set<string>> {
  const response = await larkCli([
    "base",
    "+field-list",
    "--as",
    "user",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--limit",
    "200",
  ]) as { data?: { fields?: Array<{ name?: string; field_name?: string }>; items?: Array<{ name?: string; field_name?: string }> } } | null

  const fields = response?.data?.fields ?? response?.data?.items ?? []
  return new Set(fields.map((field) => field.name ?? field.field_name).filter(Boolean) as string[])
}

async function findEventHubRecordId(tableId: string, eventKey: string): Promise<string | null> {
  const response = await larkCli([
    "base",
    "+record-list",
    "--as",
    "user",
    "--base-token",
    config.feishu.baseToken,
    "--table-id",
    tableId,
    "--limit",
    "200",
  ]) as { data?: { data?: unknown[][]; fields?: string[]; record_id_list?: string[] } } | null

  const fields = response?.data?.fields ?? []
  const rows = response?.data?.data ?? []
  const ids = response?.data?.record_id_list ?? []
  const keyIndex = fields.indexOf(EVENT_KEY_FIELD)
  if (keyIndex < 0) return null

  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.[keyIndex] === eventKey) {
      return ids[i] ?? null
    }
  }

  return null
}

async function requireEventHubRecordId(tableId: string, eventKey: string): Promise<string> {
  const recordId = await findEventHubRecordId(tableId, eventKey)
  if (!recordId) throw new Error(`Failed to create or locate Feishu Base event hub record: ${eventKey}`)
  return recordId
}

function toBaseFields(route: EventHubRoute): Record<string, unknown> {
  return {
    [EVENT_KEY_FIELD]: route.eventKey,
    "事件类型": route.eventType,
    "来源类型": route.sourceType,
    "输入/命令": route.triggerCommand,
    "目标工作流": route.workflowName,
    "中枢状态": route.status,
    "已完成": route.completed,
    "需异步拉取": route.requiresPull,
    "需Hub上下文": route.requiresHub,
    "OpenClaw路由": route.openclawRoute,
    "失败处理策略": route.failureStrategy,
    "用户操作": route.userAction,
    "说明": route.description,
    "最后同步时间": formatDateTime(new Date()),
  }
}

function fallbackRoute(eventKey: string): EventHubRoute {
  return {
    eventKey,
    eventType: eventKey,
    sourceType: "doc",
    triggerCommand: "手动命令",
    workflowName: "unknown",
    status: "启用",
    completed: false,
    requiresPull: false,
    requiresHub: false,
    openclawRoute: "不进入",
    failureStrategy: "人工维护该事件路由后再启用。",
    userAction: "手动维护事件中枢状态",
    description: "未在本地事件路由注册表中找到该事件键。",
  }
}

function selectOptions(names: string[]) {
  return names.map((name) => ({ name, hue: "Blue", lightness: "Lighter" }))
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_")
}

function formatDateTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function writeBaseJsonFile(fields: Record<string, unknown>): string {
  const filename = `./event-hub-record-${randomUUID()}.json`
  writeFileSync(filename, JSON.stringify(fields), "utf-8")
  return `@${filename}`
}
