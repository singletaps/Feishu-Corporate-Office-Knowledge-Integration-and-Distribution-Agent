import { db } from "../shared/db.js"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import {
  listActiveItems,
} from "../domain/work-item.js"
import { extractMeetingItemsFlow, inspectRisksFlow, syncWorkItemHubFlow } from "../application/work-item-service.js"
import {
  generatePreMeetingBriefFlow,
  generateTaskDigestFlow,
  ingestSourceItemsFlow,
} from "../application/source-ingestion-service.js"
import {
  extractMeetingItemsSchema,
  generatePreMeetingBriefSchema,
  generateTaskDigestSchema,
  getWorkItemEvidenceSchema,
  ingestSourceItemsSchema,
  syncWorkItemHubSchema,
  visualizeEventHubSchema,
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
  "/tools/ingestSourceItems": ingestSourceItems,
  "/tools/syncWorkItemHub": syncWorkItemHub,
  "/tools/inspectRisks": inspectRisks,
  "/tools/queryWorkItems": queryWorkItems,
  "/tools/getWorkItemEvidence": getWorkItemEvidence,
  "/tools/summarizeWorkItemHub": summarizeWorkItemHub,
  "/tools/generatePreMeetingBrief": generatePreMeetingBrief,
  "/tools/generateTaskDigest": generateTaskDigest,
  "/tools/visualizeEventHub": visualizeEventHub,
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

async function ingestSourceItems(raw: unknown) {
  const input = ingestSourceItemsSchema.parse(raw)
  log.info("agent tool ingestSourceItems", {
    originChannel: input.originChannel,
    originContextId: input.originContextId,
    contentLength: input.contentText.length,
  })

  const result = await ingestSourceItemsFlow({
    originChannel: input.originChannel,
    originContextId: input.originContextId,
    title: input.title,
    contentText: input.contentText,
    ownerUserId: input.ownerUserId,
    sourceUrl: input.sourceUrl,
    participants: input.participants,
    projectToBase: input.projectToBase,
    changedById: "agent-tool:ingestSourceItems",
  })

  return {
    ok: true,
    originChannel: result.originChannel,
    originContextId: result.originContextId,
    assetId: result.assetId,
    extractedCount: result.extractedCount,
    savedCount: result.savedCount,
    projectedCount: result.projectedCount,
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

async function getWorkItemEvidence(raw: unknown) {
  const input = getWorkItemEvidenceSchema.parse(raw)
  const refs = await db.query<{
    id: string
    relationType: string
    excerpt: string | null
    confidenceScore: number | null
    assetId: string | null
    assetType: string | null
    sourceId: string | null
    title: string | null
    contentText: string | null
  }>(
    `SELECT
       sr.id,
       sr.relation_type,
       sr.excerpt,
       sr.confidence_score,
       sr.asset_id,
       ka.asset_type,
       ka.source_id,
       ka.title,
       ka.content_text
     FROM source_references sr
     LEFT JOIN knowledge_assets ka ON ka.id = sr.asset_id
     WHERE sr.target_type = 'work_item'
       AND sr.target_id = $1
     ORDER BY sr.created_at ASC`,
    [input.workItemId],
  )

  return {
    ok: true,
    workItemId: input.workItemId,
    count: refs.length,
    evidence: refs.map((ref) => ({
      id: ref.id,
      relationType: ref.relationType,
      excerpt: ref.excerpt,
      confidenceScore: ref.confidenceScore,
      assetId: ref.assetId,
      assetType: ref.assetType,
      sourceId: ref.sourceId,
      title: ref.title,
      contentPreview: ref.contentText?.slice(0, 500) ?? null,
    })),
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

async function generatePreMeetingBrief(raw: unknown) {
  const input = generatePreMeetingBriefSchema.parse(raw)
  const result = await generatePreMeetingBriefFlow(input)

  return {
    ok: true,
    artifactId: result.artifact.id,
    title: result.artifact.title,
    summary: result.artifact.summary,
    relatedItemCount: result.relatedItemCount,
    contentPayload: result.artifact.contentPayload,
  }
}

async function generateTaskDigest(raw: unknown) {
  const input = generateTaskDigestSchema.parse(raw)
  const result = await generateTaskDigestFlow(input.limit)

  return {
    ok: true,
    artifactId: result.artifact.id,
    title: result.artifact.title,
    summary: result.artifact.summary,
    relatedItemCount: result.relatedItemCount,
    contentPayload: result.artifact.contentPayload,
  }
}

async function visualizeEventHub(raw: unknown) {
  const input = visualizeEventHubSchema.parse(raw)
  const edges = [
    ["vc.meeting.meeting_started_v1", "pre-meeting-brief"],
    ["meeting_start", "pre-meeting-brief"],
    ["vc.meeting.meeting_ended_v1", "post-meeting-extraction"],
    ["meeting_end", "post-meeting-extraction"],
    ["card.action.trigger", "card-callback"],
    ["card_callback", "card-callback"],
    ["im.message.receive_v1", "source-ingestion"],
    ["im_message", "source-ingestion"],
    ["doc_update", "source-ingestion"],
    ["wiki_update", "source-ingestion"],
    ["task_update", "source-ingestion"],
    ["mail_received", "source-ingestion"],
  ] as const
  const nodes = Array.from(new Set(edges.flat())).map((id) => ({
    id,
    kind: id.includes(".") || id.includes("_") ? "event" : "workflow",
  }))
  const mermaid = input.includeMermaid
    ? [
        "flowchart LR",
        ...edges.map(([from, to]) => `  ${sanitizeMermaidId(from)}[\"${from}\"] --> ${sanitizeMermaidId(to)}[\"${to}\"]`),
      ].join("\n")
    : null

  return {
    ok: true,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges: edges.map(([from, to]) => ({ from, to })),
    mermaid,
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

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_")
}
