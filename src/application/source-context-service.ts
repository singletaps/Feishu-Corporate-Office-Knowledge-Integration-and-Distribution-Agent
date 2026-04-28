import { createHash } from "node:crypto"
import { db } from "../shared/db.js"
import type { OriginChannel } from "../shared/types.js"
import type { HubCandidate, HubEvidenceBundle } from "../domain/hub-assignment.js"

export interface SourceContextInput {
  originChannel: OriginChannel
  originContextId: string
  title?: string
  contentText?: string
  sourceUrl?: string
  chatId?: string
  chatType?: "group" | "p2p" | "unknown"
  actorOpenId?: string
  ownerUserId?: string
  participantOpenIds?: string[]
  mentionedUserIds?: string[]
  docToken?: string
  wikiSpaceId?: string
  folderToken?: string
  calendarEventId?: string
  explicitHubId?: string
  eventType?: string
  changedById?: string
}

export interface SourceContextSnapshot {
  id: string
  evidence: HubEvidenceBundle
  evidenceHash: string
}

interface HubRow {
  id: string
  hubType: "team" | "personal" | "org" | "legacy"
  name: string
  ownerUserId: string | null
  defaultChatId: string | null
}

interface ResourceBindingRow {
  hubId: string
  hubType: "team" | "personal" | "org" | "legacy"
  name: string
  resourceType: string
  resourceToken: string
  priority: number
}

export async function collectSourceContext(input: SourceContextInput): Promise<HubEvidenceBundle> {
  const explicitBindings = await collectExplicitBindings(input)
  const candidates = new Map<string, HubCandidate>()

  if (input.explicitHubId) {
    await addHubCandidate(candidates, input.explicitHubId, ["explicit_binding"], [], 1)
  }

  if (input.chatId) {
    await collectChatCandidates(candidates, input.chatId)
  }

  await collectResourceBindingCandidates(candidates, input)
  await collectPeopleCandidates(candidates, [
    input.ownerUserId,
    input.actorOpenId,
    ...(input.participantOpenIds ?? []),
    ...(input.mentionedUserIds ?? []),
  ].filter((value): value is string => Boolean(value)))

  const similarWorkItems = await findSimilarWorkItems(input.originChannel, input.originContextId)
  for (const similar of similarWorkItems) {
    if (similar.primaryHubId) {
      await addHubCandidate(candidates, similar.primaryHubId, ["similar_work_item"], [], 0.92)
    }
  }

  return {
    source: {
      originChannel: input.originChannel,
      originContextId: input.originContextId,
      sourceUrl: input.sourceUrl ?? null,
      eventType: input.eventType ?? null,
    },
    explicitBindings,
    resourceContext: {
      chatId: input.chatId ?? null,
      chatType: input.chatType ?? inferChatType(input),
      calendarEventId: input.calendarEventId ?? null,
      docToken: input.docToken ?? null,
      wikiSpaceId: input.wikiSpaceId ?? null,
      folderToken: input.folderToken ?? null,
    },
    peopleContext: {
      actorOpenId: input.actorOpenId ?? null,
      participants: input.participantOpenIds ?? [],
      attendees: [],
      mentionedUsers: input.mentionedUserIds ?? [],
      editors: [],
      commentAuthors: input.originChannel === "doc" || input.originChannel === "wiki"
        ? [input.actorOpenId].filter((value): value is string => Boolean(value))
        : [],
    },
    candidateHubs: Array.from(candidates.values()).sort((a, b) => b.priorScore - a.priorScore),
    contentSignals: extractContentSignals(input.title, input.contentText),
    similarWorkItems,
  }
}

export async function saveSourceContextSnapshot(
  evidence: HubEvidenceBundle,
  changedById?: string,
): Promise<SourceContextSnapshot> {
  const evidenceJson = JSON.stringify(evidence)
  const evidenceHash = createHash("sha256").update(evidenceJson).digest("hex")
  const rows = await db.query<{ id: string }>(
    `INSERT INTO source_context_snapshots
       (origin_channel, origin_context_id, evidence_json, evidence_hash, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      evidence.source.originChannel,
      evidence.source.originContextId,
      evidenceJson,
      evidenceHash,
      changedById ?? null,
    ],
  )

  return { id: rows[0].id, evidence, evidenceHash }
}

async function collectExplicitBindings(input: SourceContextInput): Promise<HubEvidenceBundle["explicitBindings"]> {
  const bindings = {
    hubIds: input.explicitHubId ? [input.explicitHubId] : [],
    docBoundHubId: null as string | null,
    chatBoundHubId: null as string | null,
    calendarBoundHubId: null as string | null,
  }

  if (input.docToken) {
    bindings.docBoundHubId = await findResourceBoundHub("doc", input.docToken)
  }
  if (input.chatId) {
    bindings.chatBoundHubId = await findChatBoundHub(input.chatId)
  }
  if (input.calendarEventId) {
    bindings.calendarBoundHubId = await findResourceBoundHub("calendar", input.calendarEventId)
  }

  return bindings
}

async function collectChatCandidates(candidates: Map<string, HubCandidate>, chatId: string): Promise<void> {
  const chatHub = await findChatBoundHub(chatId)
  if (chatHub) {
    await addHubCandidate(candidates, chatHub, ["chat_binding"], [], 0.95)
  }
}

async function collectResourceBindingCandidates(
  candidates: Map<string, HubCandidate>,
  input: SourceContextInput,
): Promise<void> {
  const resources = [
    ["doc", input.docToken],
    ["wiki_space", input.wikiSpaceId],
    ["folder", input.folderToken],
    ["calendar", input.calendarEventId],
    [input.originChannel === "meeting" ? "meeting" : "", input.originContextId],
  ].filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1]))

  if (resources.length === 0) return

  const rows = await db.query<ResourceBindingRow>(
    `SELECT
       hrb.hub_id,
       ih.hub_type,
       ih.name,
       hrb.resource_type,
       hrb.resource_token,
       hrb.priority
     FROM hub_resource_bindings hrb
     JOIN item_hubs ih ON ih.id = hrb.hub_id
     WHERE ih.hub_status = 'active'
       AND hrb.status = 'active'
       AND (hrb.resource_type, hrb.resource_token) IN (${resources.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(", ")})
     ORDER BY hrb.priority ASC, hrb.created_at ASC`,
    resources.flat(),
  )

  for (const row of rows) {
    mergeCandidate(candidates, {
      hubId: row.hubId,
      hubType: row.hubType,
      name: row.name,
      matchedBy: ["resource_binding", `${row.resourceType}:${row.resourceToken}`],
      membersInvolved: [],
      priorScore: Math.max(0.6, 0.9 - row.priority / 1000),
    })
  }
}

async function collectPeopleCandidates(candidates: Map<string, HubCandidate>, userOpenIds: string[]): Promise<void> {
  const uniqueUsers = Array.from(new Set(userOpenIds))
  if (uniqueUsers.length === 0) return

  const rows = await db.query<HubRow & { userOpenId: string }>(
    `SELECT ih.*, hm.user_open_id
     FROM hub_members hm
     JOIN item_hubs ih ON ih.id = hm.hub_id
     WHERE hm.user_open_id = ANY($1::text[])
       AND ih.hub_status = 'active'`,
    [uniqueUsers],
  )

  for (const row of rows) {
    mergeCandidate(candidates, {
      hubId: row.id,
      hubType: row.hubType,
      name: row.name,
      matchedBy: ["member_relation"],
      membersInvolved: [row.userOpenId],
      priorScore: row.hubType === "personal" ? 0.72 : 0.48,
    })
  }
}

async function addHubCandidate(
  candidates: Map<string, HubCandidate>,
  hubId: string,
  matchedBy: string[],
  membersInvolved: string[],
  priorScore: number,
): Promise<void> {
  const hub = await db.queryOne<HubRow>(
    `SELECT * FROM item_hubs WHERE id = $1 AND hub_status = 'active'`,
    [hubId],
  )
  if (!hub) return

  mergeCandidate(candidates, {
    hubId: hub.id,
    hubType: hub.hubType,
    name: hub.name,
    matchedBy,
    membersInvolved,
    priorScore,
  })
}

function mergeCandidate(candidates: Map<string, HubCandidate>, next: HubCandidate): void {
  const existing = candidates.get(next.hubId)
  if (!existing) {
    candidates.set(next.hubId, next)
    return
  }

  candidates.set(next.hubId, {
    ...existing,
    matchedBy: Array.from(new Set([...existing.matchedBy, ...next.matchedBy])),
    membersInvolved: Array.from(new Set([...existing.membersInvolved, ...next.membersInvolved])),
    priorScore: Math.max(existing.priorScore, next.priorScore),
  })
}

async function findChatBoundHub(chatId: string): Promise<string | null> {
  const direct = await db.queryOne<{ id: string }>(
    `SELECT id FROM item_hubs
     WHERE default_chat_id = $1 AND hub_status = 'active'
     ORDER BY created_at ASC
     LIMIT 1`,
    [chatId],
  )
  if (direct) return direct.id
  return findResourceBoundHub("chat", chatId)
}

async function findResourceBoundHub(resourceType: string, resourceToken: string): Promise<string | null> {
  const row = await db.queryOne<{ hubId: string }>(
    `SELECT hub_id
     FROM hub_resource_bindings
     WHERE resource_type = $1
       AND resource_token = $2
       AND status = 'active'
     ORDER BY priority ASC, created_at ASC
     LIMIT 1`,
    [resourceType, resourceToken],
  )
  return row?.hubId ?? null
}

async function findSimilarWorkItems(
  originChannel: OriginChannel,
  originContextId: string,
): Promise<HubEvidenceBundle["similarWorkItems"]> {
  const rows = await db.query<{
    workItemId: string
    primaryHubId: string | null
  }>(
    `SELECT wi.id AS work_item_id, p.hub_id AS primary_hub_id
     FROM work_items wi
     LEFT JOIN work_item_hub_projections p
       ON p.work_item_id = wi.id
      AND p.projection_role = 'primary'
      AND p.sync_status <> 'removed'
     WHERE wi.origin_channel = $1
       AND wi.origin_context_id = $2
       AND wi.deleted_at IS NULL
     ORDER BY wi.created_at DESC
     LIMIT 10`,
    [originChannel, originContextId],
  )

  return rows.map((row) => ({
    workItemId: row.workItemId,
    primaryHubId: row.primaryHubId,
    similarityReason: "same origin channel and context",
  }))
}

function extractContentSignals(title?: string, contentText?: string): HubEvidenceBundle["contentSignals"] {
  const text = `${title ?? ""}\n${contentText ?? ""}`
  return {
    title: title ?? null,
    excerpt: contentText?.replace(/\s+/g, " ").trim().slice(0, 500) ?? null,
    mentionedTeams: extractMatches(text, /([A-Z][A-Za-z0-9_-]{0,20}|[\u4e00-\u9fa5]{1,12}(?:团队|项目|后端|前端|测试|产品))/gu),
    actionVerbs: extractMatches(text, /(负责|完成|跟进|确认|验收|修复|补充|整理|交付|review|fix|todo|deadline|ddl)/giu),
    sensitive: /(绩效|人事|薪资|客户|合同|权限|裁员|投诉|事故)/u.test(text),
  }
}

function extractMatches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern)).map((match) => match[1] ?? match[0]).slice(0, 20)
}

function inferChatType(input: SourceContextInput): "group" | "p2p" | "unknown" {
  if (!input.chatId) return "unknown"
  return input.chatId.startsWith("ou_") ? "p2p" : "group"
}
