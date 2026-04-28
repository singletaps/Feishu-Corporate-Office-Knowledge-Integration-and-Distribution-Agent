import { config } from "../shared/config.js"
import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import { projectWorkItemsToBase } from "../integration/base.js"
import { extractWorkItems, listActiveItems, reconcileAndSave } from "../domain/work-item.js"
import { generatePreMeetingBrief, generateTaskDigest } from "../domain/artifact.js"
import {
  applyHubAssignment,
  collectSourceContextForAssignment,
  type ApplyHubAssignmentResult,
} from "./hub-assignment-service.js"
import type { FeishuUser, KnowledgeArtifact, OriginChannel, WorkItem } from "../shared/types.js"

export interface SourceParticipantInput {
  openId: string
  name: string
  email?: string
}

export interface IngestSourceItemsOptions {
  originChannel: OriginChannel
  originContextId: string
  title?: string
  contentText: string
  ownerUserId?: string
  sourceUrl?: string
  chatId?: string
  chatType?: "group" | "p2p" | "unknown"
  actorOpenId?: string
  mentionedUserIds?: string[]
  docToken?: string
  wikiSpaceId?: string
  folderToken?: string
  calendarEventId?: string
  participants?: SourceParticipantInput[]
  projectToBase?: boolean
  hubId?: string
  changedById?: string
}

export interface IngestSourceItemsResult {
  originChannel: OriginChannel
  originContextId: string
  assetId: string
  extractedCount: number
  savedCount: number
  projectedCount: number
  assignmentResults: ApplyHubAssignmentResult[]
  baseUrl: string
  items: WorkItem[]
}

export interface GeneratePreMeetingBriefOptions {
  meetingId: string
  meetingTitle: string
  topicText?: string
  chatId?: string
  limit?: number
}

export interface GenerateArtifactResult {
  artifact: KnowledgeArtifact
  relatedItemCount: number
}

export async function ingestSourceItemsFlow(
  options: IngestSourceItemsOptions,
): Promise<IngestSourceItemsResult> {
  const projectToBase = options.projectToBase ?? true
  const participants = options.participants ?? []
  const assetId = await upsertKnowledgeAsset({
    originChannel: options.originChannel,
    originContextId: options.originContextId,
    title: options.title,
    contentText: options.contentText,
    ownerUserId: options.ownerUserId,
    sourceUrl: options.sourceUrl,
  })

  log.info("ingesting source items", {
    originChannel: options.originChannel,
    originContextId: options.originContextId,
    assetId,
    contentLength: options.contentText.length,
  })

  const extracted = await extractWorkItems(
    options.contentText,
    participants,
    options.originChannel,
    options.originContextId,
  )
  const saved = await reconcileAndSave(
    extracted,
    options.originChannel,
    options.originContextId,
    participants,
    {
      changedById: options.changedById ?? `source-ingestion:${options.originChannel}`,
      sourceAssetId: assetId,
      sourceExcerpt: buildExcerpt(options.contentText),
      mergeAcrossSources: true,
    },
  )

  const assignmentResults: ApplyHubAssignmentResult[] = []
  let projectedCount = 0

  for (const item of saved) {
    const evidence = await collectSourceContextForAssignment({
      originChannel: options.originChannel,
      originContextId: options.originContextId,
      title: options.title ?? item.title,
      contentText: options.contentText,
      sourceUrl: options.sourceUrl,
      chatId: options.chatId,
      chatType: options.chatType,
      actorOpenId: options.actorOpenId ?? options.ownerUserId,
      ownerUserId: item.ownerUserId ?? options.ownerUserId,
      participantOpenIds: participants.map((participant) => participant.openId),
      mentionedUserIds: options.mentionedUserIds,
      docToken: options.docToken,
      wikiSpaceId: options.wikiSpaceId,
      folderToken: options.folderToken,
      calendarEventId: options.calendarEventId,
      explicitHubId: options.hubId,
      changedById: options.changedById,
    })
    const assignment = await applyHubAssignment({
      workItem: item,
      evidence,
      changedById: options.changedById ?? `source-ingestion:${options.originChannel}`,
    })
    assignmentResults.push(assignment)

    if (projectToBase && assignment.appliedHubIds.length > 0) {
      for (const hubId of assignment.appliedHubIds) {
        await projectWorkItemsToBase([item], { hubId })
        projectedCount += 1
      }
    }
  }

  return {
    originChannel: options.originChannel,
    originContextId: options.originContextId,
    assetId,
    extractedCount: extracted.length,
    savedCount: saved.length,
    projectedCount,
    assignmentResults,
    baseUrl: config.feishu.baseUrl,
    items: saved,
  }
}

export async function generatePreMeetingBriefFlow(
  options: GeneratePreMeetingBriefOptions,
): Promise<GenerateArtifactResult> {
  const items = await listActiveItems({ limit: options.limit ?? 50 })
  const related = pickRelatedItems(items, `${options.meetingTitle}\n${options.topicText ?? ""}`)
  const artifact = await generatePreMeetingBrief(
    {
      meetingId: options.meetingId,
      meetingTitle: options.meetingTitle,
      topicText: options.topicText,
      chatId: options.chatId,
    },
    related,
  )

  return { artifact, relatedItemCount: related.length }
}

export async function generateTaskDigestFlow(limit = 100): Promise<GenerateArtifactResult> {
  const items = await listActiveItems({ limit })
  const artifact = await generateTaskDigest(items)
  return { artifact, relatedItemCount: items.length }
}

async function upsertKnowledgeAsset(input: {
  originChannel: OriginChannel
  originContextId: string
  title?: string
  contentText: string
  ownerUserId?: string
  sourceUrl?: string
}): Promise<string> {
  const assetType = toAssetType(input.originChannel)
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM knowledge_assets WHERE asset_type = $1 AND source_id = $2 LIMIT 1`,
    [assetType, input.originContextId],
  )
  const metadataText = input.sourceUrl
    ? `${input.contentText}\n\n来源链接: ${input.sourceUrl}`
    : input.contentText

  if (existing) {
    await db.execute(
      `UPDATE knowledge_assets
       SET title = $3, content_text = $4, owner_user_id = $5, updated_at = now()
       WHERE asset_type = $1 AND source_id = $2`,
      [assetType, input.originContextId, input.title ?? null, metadataText, input.ownerUserId ?? null],
    )
    return existing.id
  }

  const rows = await db.query<{ id: string }>(
    `INSERT INTO knowledge_assets (asset_type, source_id, title, content_text, owner_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [assetType, input.originContextId, input.title ?? null, metadataText, input.ownerUserId ?? null],
  )

  return rows[0].id
}

function toAssetType(originChannel: OriginChannel): string {
  if (originChannel === "im") return "im_message"
  if (originChannel === "task") return "task_snapshot"
  if (originChannel === "meeting" || originChannel === "minutes") return "minutes"
  return originChannel
}

function buildExcerpt(contentText: string): string {
  return contentText.replace(/\s+/g, " ").trim().slice(0, 500)
}

function pickRelatedItems(items: WorkItem[], topicText: string): WorkItem[] {
  const tokens = new Set(
    topicText
      .toLowerCase()
      .split(/[\s,.;:!?，。；：！？、]+/u)
      .filter((token) => token.length >= 2),
  )

  if (tokens.size === 0) {
    return items.slice(0, 10)
  }

  const scored = items.map((item) => {
    const haystack = `${item.title} ${String(item.metadata?.reasoning ?? "")}`.toLowerCase()
    const score = Array.from(tokens).filter((token) => haystack.includes(token)).length
    return { item, score }
  })

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((entry) => entry.item)
}
