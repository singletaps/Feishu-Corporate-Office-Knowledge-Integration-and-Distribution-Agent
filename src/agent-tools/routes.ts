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
  applyHubAssignment,
  collectSourceContextForAssignment,
  decideWorkItemHub as decideWorkItemHubInService,
  explainHubAssignment as explainHubAssignmentInService,
} from "../application/hub-assignment-service.js"
import {
  completeEventHubTask as completeEventHubTaskInFeishu,
  getEventHubRoutes,
  publishEventHubView as publishEventHubViewToFeishu,
  renderEventHubMermaid,
} from "../application/event-hub-visualization-service.js"
import {
  bindHubSession,
  ensureDefaultHub,
  getActiveHub,
  inviteHubMember,
  listHubsForUser,
  removeHubMember,
  resolveHubForChat,
  transferHubAdmin,
  updateHubMemberRole,
} from "../application/hub-service.js"
import {
  completeEventHubTaskSchema,
  applyHubAssignmentSchema,
  decideWorkItemHubSchema,
  explainHubAssignmentSchema,
  extractMeetingItemsSchema,
  generatePreMeetingBriefSchema,
  generateTaskDigestSchema,
  getWorkItemEvidenceSchema,
  ingestSourceItemsSchema,
  sourceContextInputSchema,
  syncWorkItemHubSchema,
  visualizeEventHubSchema,
  inspectRisksSchema,
  queryWorkItemsSchema,
  summarizeWorkItemHubSchema,
  publishEventHubViewSchema,
  hubMemberMutationSchema,
  hubTransferAdminSchema,
  listHubsSchema,
  resolveHubSchema,
  selectHubSchema,
} from "./schemas.js"
import type { WorkItem } from "../shared/types.js"
import { hubAssignmentDecisionSchema, type HubEvidenceBundle } from "../domain/hub-assignment.js"

export async function handleToolRequest(pathname: string, body: unknown): Promise<unknown> {
  const handler = toolHandlers[pathname]
  if (!handler) return { ok: false, error: `unknown tool path: ${pathname}` }
  return handler(body)
}

const toolHandlers: Record<string, (body: unknown) => Promise<unknown>> = {
  "/tools/extractMeetingItems": extractMeetingItems,
  "/tools/ingestSourceItems": ingestSourceItems,
  "/tools/collectSourceContext": collectSourceContext,
  "/tools/listCandidateHubs": collectSourceContext,
  "/tools/decideWorkItemHub": decideWorkItemHub,
  "/tools/applyHubAssignment": applyHubAssignmentTool,
  "/tools/explainHubAssignment": explainHubAssignment,
  "/tools/syncWorkItemHub": syncWorkItemHub,
  "/tools/inspectRisks": inspectRisks,
  "/tools/queryWorkItems": queryWorkItems,
  "/tools/getWorkItemEvidence": getWorkItemEvidence,
  "/tools/summarizeWorkItemHub": summarizeWorkItemHub,
  "/tools/generatePreMeetingBrief": generatePreMeetingBrief,
  "/tools/generateTaskDigest": generateTaskDigest,
  "/tools/visualizeEventHub": visualizeEventHub,
  "/tools/publishEventHubView": publishEventHubView,
  "/tools/completeEventHubTask": completeEventHubTask,
  "/tools/listHubs": listHubs,
  "/tools/resolveHub": resolveHub,
  "/tools/selectHub": selectHub,
  "/tools/hubInviteMember": hubInviteMember,
  "/tools/hubRemoveMember": hubRemoveMember,
  "/tools/hubUpdateMemberRole": hubUpdateMemberRole,
  "/tools/hubTransferAdmin": hubTransferAdmin,
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
    chatId: input.chatId,
    chatType: input.chatType,
    actorOpenId: input.actorOpenId,
    mentionedUserIds: input.mentionedUserIds,
    docToken: input.docToken,
    wikiSpaceId: input.wikiSpaceId,
    folderToken: input.folderToken,
    calendarEventId: input.calendarEventId,
    participants: input.participants,
    projectToBase: input.projectToBase,
    hubId: input.hubId,
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

async function collectSourceContext(raw: unknown) {
  const input = sourceContextInputSchema.parse(raw)
  const evidence = await collectSourceContextForAssignment(input)
  return {
    ok: true,
    candidateHubCount: evidence.candidateHubs.length,
    evidence,
  }
}

async function decideWorkItemHub(raw: unknown) {
  const input = decideWorkItemHubSchema.parse(raw)
  const workItem = input.workItemId ? await findWorkItemForTool(input.workItemId) : undefined
  const decision = await decideWorkItemHubInService(input.evidence as unknown as HubEvidenceBundle, workItem ?? undefined)
  return {
    ok: true,
    decision,
  }
}

async function applyHubAssignmentTool(raw: unknown) {
  const input = applyHubAssignmentSchema.parse(raw)
  const workItem = await findWorkItemForTool(input.workItemId)
  if (!workItem) return { ok: false, error: "work item not found" }
  const decision = input.decision ? hubAssignmentDecisionSchema.parse(input.decision) : undefined
  const result = await applyHubAssignment({
    workItem,
    evidence: input.evidence as unknown as HubEvidenceBundle,
    decision,
    changedById: input.changedById ?? "agent-tool:applyHubAssignment",
  })
  return {
    ok: true,
    ...result,
  }
}

async function explainHubAssignment(raw: unknown) {
  const input = explainHubAssignmentSchema.parse(raw)
  const explanation = await explainHubAssignmentInService(input.workItemId)
  return {
    ok: true,
    ...explanation,
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
  const routes = getEventHubRoutes()
  const edges = routes.map((route) => ({ from: route.eventType, to: route.workflowName }))
  const nodes = Array.from(new Set(edges.flatMap((edge) => [edge.from, edge.to]))).map((id) => ({
    id,
    kind: id.includes(".") || id.includes("_") ? "event" : "workflow",
  }))
  const mermaid = input.includeMermaid ? renderEventHubMermaid() : null

  return {
    ok: true,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    routes,
    mermaid,
  }
}

async function publishEventHubView(raw: unknown) {
  publishEventHubViewSchema.parse(raw)
  const result = await publishEventHubViewToFeishu()
  return { ok: true, ...result }
}

async function completeEventHubTask(raw: unknown) {
  const input = completeEventHubTaskSchema.parse(raw)
  const result = await completeEventHubTaskInFeishu(input.eventKey, input.completed)
  return { ok: true, ...result }
}

async function listHubs(raw: unknown) {
  const input = listHubsSchema.parse(raw)
  const hubs = input.actorOpenId
    ? await listHubsForUser(input.actorOpenId)
    : [await ensureDefaultHub()]
  return { ok: true, count: hubs.length, hubs: hubs.map(toHubSummary) }
}

async function resolveHub(raw: unknown) {
  const input = resolveHubSchema.parse(raw)
  const hub = await resolveHubForChat(input.chatId, input.actorOpenId)
  return { ok: true, hub: toHubSummary(hub) }
}

async function selectHub(raw: unknown) {
  const input = selectHubSchema.parse(raw)
  await bindHubSession(input.chatId, input.actorOpenId, input.hubId)
  const hub = await getActiveHub(input.hubId)
  return { ok: true, selected: toHubSummary(hub) }
}

async function hubInviteMember(raw: unknown) {
  const input = hubMemberMutationSchema.parse(raw)
  const member = await inviteHubMember(input)
  return { ok: true, member }
}

async function hubRemoveMember(raw: unknown) {
  const input = hubMemberMutationSchema.parse(raw)
  const result = await removeHubMember(input)
  return { ok: true, ...result }
}

async function hubUpdateMemberRole(raw: unknown) {
  const input = hubMemberMutationSchema.parse(raw)
  if (!input.role) {
    return { ok: false, code: "INVALID_TOOL_INPUT", error: "role is required" }
  }
  const member = await updateHubMemberRole({ ...input, role: input.role })
  return { ok: true, member }
}

async function hubTransferAdmin(raw: unknown) {
  const input = hubTransferAdminSchema.parse(raw)
  const member = await transferHubAdmin(input)
  return { ok: true, member }
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

async function findWorkItemForTool(workItemId: string): Promise<WorkItem | null> {
  return db.queryOne<WorkItem>(
    `SELECT * FROM work_items WHERE id = $1 AND deleted_at IS NULL`,
    [workItemId],
  )
}

function toHubSummary(hub: {
  id: string
  name: string
  hubType: string
  defaultChatId: string | null
  ownerUserId: string | null
  hubStatus: string
}) {
  return {
    id: hub.id,
    name: hub.name,
    hubType: hub.hubType,
    defaultChatId: hub.defaultChatId,
    ownerUserId: hub.ownerUserId,
    hubStatus: hub.hubStatus,
  }
}

