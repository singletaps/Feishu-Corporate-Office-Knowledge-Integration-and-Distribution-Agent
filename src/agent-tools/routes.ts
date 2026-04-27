import { db } from "../shared/db.js"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import {
  listActiveItems,
} from "../domain/work-item.js"
import { extractMeetingItemsFlow, inspectRisksFlow, syncWorkItemHubFlow } from "../application/work-item-service.js"
import {
  extractMeetingItemsSchema,
  syncWorkItemHubSchema,
  inspectRisksSchema,
  queryWorkItemsSchema,
  summarizeWorkItemHubSchema,
} from "./schemas.js"
import type { WorkItem } from "../shared/types.js"

export async function handleToolRequest(pathname: string, body: unknown): Promise<unknown> {
  const handler = toolHandlers[pathname]
  if (!handler) return { ok: false, error: `unknown tool path: ${pathname}` }
  return handler(body)
}

const toolHandlers: Record<string, (body: unknown) => Promise<unknown>> = {
  "/tools/extractMeetingItems": extractMeetingItems,
  "/tools/syncWorkItemHub": syncWorkItemHub,
  "/tools/inspectRisks": inspectRisks,
  "/tools/queryWorkItems": queryWorkItems,
  "/tools/summarizeWorkItemHub": summarizeWorkItemHub,
}

async function extractMeetingItems(raw: unknown) {
  const input = extractMeetingItemsSchema.parse(raw)
  log.info("agent tool extractMeetingItems", input)

  const result = await extractMeetingItemsFlow({
    meetingId: input.meetingId,
    chatId: input.chatId,
    sendCard: input.sendCard,
    createTasks: input.createTasks,
    projectToBase: true,
    changedById: "agent-tool:extractMeetingItems",
  })

  return {
    ok: true,
    meetingId: result.meetingId,
    meetingTitle: result.meetingTitle,
    extractedCount: result.extractedCount,
    savedCount: result.savedCount,
    tasksCreated: result.tasksCreated,
    cardMessageId: result.cardMessageId,
    baseUrl: result.baseUrl,
    items: result.items.map(toItemSummary),
  }
}

async function syncWorkItemHub(raw: unknown) {
  const input = syncWorkItemHubSchema.parse(raw)
  log.info("agent tool syncWorkItemHub", input)

  const result = await syncWorkItemHubFlow(input.limit)

  return {
    ok: true,
    ...result,
  }
}

async function inspectRisks(raw: unknown) {
  const input = inspectRisksSchema.parse(raw)
  log.info("agent tool inspectRisks", input)

  const result = await inspectRisksFlow(input.sendAlerts)

  return {
    ok: true,
    overdueCount: result.overdueCount,
    blockedCount: result.blockedCount,
    projectedCount: result.projectedCount,
    alertedOwnerCount: result.alertedOwnerCount,
    sendAlertsRequested: input.sendAlerts,
    baseUrl: result.baseUrl,
    items: result.items.map(toItemSummary),
  }
}

async function queryWorkItems(raw: unknown) {
  const input = queryWorkItemsSchema.parse(raw)
  const conditions = ["deleted_at IS NULL"]
  const params: unknown[] = []
  let idx = 1

  if (input.ownerUserId) {
    conditions.push(`owner_user_id = $${idx++}`)
    params.push(input.ownerUserId)
  }
  if (input.status?.length) {
    conditions.push(`status = ANY($${idx++}::text[])`)
    params.push(input.status)
  }
  if (input.itemType) {
    conditions.push(`item_type = $${idx++}`)
    params.push(input.itemType)
  }
  if (input.originChannel) {
    conditions.push(`origin_channel = $${idx++}`)
    params.push(input.originChannel)
  }

  params.push(input.limit)
  const items = await db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE ${conditions.join(" AND ")}
     ORDER BY COALESCE(due_at, created_at) ASC
     LIMIT $${idx}`,
    params,
  )

  return {
    ok: true,
    count: items.length,
    items: items.map(toItemSummary),
  }
}

async function summarizeWorkItemHub(raw: unknown) {
  const input = summarizeWorkItemHubSchema.parse(raw)
  const items = await listActiveItems({ limit: input.limit })
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1
    acc[item.itemType] = (acc[item.itemType] ?? 0) + 1
    return acc
  }, {})

  const topRisks = items
    .filter((item) => item.itemType === "risk" || item.status === "blocked")
    .slice(0, 5)
    .map(toItemSummary)

  return {
    ok: true,
    totalActive: items.length,
    counts,
    topRisks,
    baseUrl: config.feishu.baseUrl,
    summary: `当前事项中枢共有 ${items.length} 条活跃事项，其中阻塞 ${counts.blocked ?? 0} 条，风险 ${counts.risk ?? 0} 条。`,
  }
}

function toItemSummary(item: WorkItem) {
  return {
    id: item.id,
    title: item.title,
    itemType: item.itemType,
    status: item.status,
    priority: item.priority,
    ownerUserId: item.ownerUserId,
    dueAt: item.dueAt,
    confidenceScore: item.confidenceScore,
    originChannel: item.originChannel,
    originContextId: item.originContextId,
  }
}
