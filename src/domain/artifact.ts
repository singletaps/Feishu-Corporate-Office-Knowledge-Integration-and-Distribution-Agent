import { ArtifactType } from "../shared/types.js"
import { db } from "../shared/db.js"
import type { WorkItem, KnowledgeArtifact } from "../shared/types.js"

export async function generateWeeklyInsight(
  weekRange: { from: Date; to: Date },
  items: WorkItem[],
): Promise<KnowledgeArtifact> {
  const counts = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1
    acc[item.itemType] = (acc[item.itemType] ?? 0) + 1
    return acc
  }, {})

  const overdueItems = items.filter((item) => item.dueAt && item.dueAt.getTime() < Date.now() && item.status !== "done")
  const riskItems = items.filter((item) => item.itemType === "risk" || item.status === "blocked")

  const contentPayload = {
    weekRange: { from: weekRange.from.toISOString(), to: weekRange.to.toISOString() },
    counts,
    overdueItems: overdueItems.slice(0, 10).map(toBriefItem),
    riskItems: riskItems.slice(0, 10).map(toBriefItem),
  }

  const rows = await db.query<KnowledgeArtifact>(
    `INSERT INTO knowledge_artifacts
       (artifact_type, title, summary, content_payload, canonical_render_format, audience_type, status, confidence_score, generated_at)
     VALUES ($1, $2, $3, $4, 'card', 'group', 'ready', 0.9, now())
     RETURNING *`,
    [
      ArtifactType.WeeklyInsight,
      "团队重点事项周洞察",
      buildSummary(items.length, overdueItems.length, riskItems.length),
      JSON.stringify(contentPayload),
    ],
  )

  const artifact = rows[0]
  await attachWorkItemReferences(artifact.id, items, "included_item")
  return artifact
}

export async function generatePreMeetingBrief(
  meeting: { meetingId: string; meetingTitle: string; topicText?: string; chatId?: string },
  relatedItems: WorkItem[],
): Promise<KnowledgeArtifact> {
  const contentPayload = {
    meetingId: meeting.meetingId,
    chatId: meeting.chatId ?? null,
    relatedItems: relatedItems.map(toBriefItem),
    relatedDocs: [],
    topicText: meeting.topicText ?? null,
  }

  const rows = await db.query<KnowledgeArtifact>(
    `INSERT INTO knowledge_artifacts
       (artifact_type, title, summary, content_payload, canonical_render_format, audience_type, status, confidence_score, generated_at)
     VALUES ($1, $2, $3, $4, 'card', 'group', 'ready', 0.85, now())
     RETURNING *`,
    [
      ArtifactType.PreMeetingBrief,
      `会前背景：${meeting.meetingTitle}`,
      buildPreMeetingSummary(meeting.meetingTitle, relatedItems),
      JSON.stringify(contentPayload),
    ],
  )

  const artifact = rows[0]
  await attachWorkItemReferences(artifact.id, relatedItems, "context")
  return artifact
}

export async function generateTaskDigest(items: WorkItem[]): Promise<KnowledgeArtifact> {
  const openTodos = items.filter((item) => item.itemType === "todo")
  const blockers = items.filter((item) => item.status === "blocked" || item.itemType === "blocker")
  const risks = items.filter((item) => item.itemType === "risk")
  const dueSoon = items
    .filter((item) => item.dueAt && item.status !== "done" && item.status !== "closed")
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
    .slice(0, 10)

  const contentPayload = {
    total: items.length,
    openTodos: openTodos.slice(0, 20).map(toBriefItem),
    blockers: blockers.slice(0, 20).map(toBriefItem),
    risks: risks.slice(0, 20).map(toBriefItem),
    dueSoon: dueSoon.map(toBriefItem),
  }

  const rows = await db.query<KnowledgeArtifact>(
    `INSERT INTO knowledge_artifacts
       (artifact_type, title, summary, content_payload, canonical_render_format, audience_type, status, confidence_score, generated_at)
     VALUES ($1, '团队事项摘要', $2, $3, 'cli_text', 'cli_local', 'ready', 0.9, now())
     RETURNING *`,
    [
      ArtifactType.TaskDigest,
      `当前共有 ${items.length} 条活跃事项，待办 ${openTodos.length} 条，风险 ${risks.length} 条，阻塞 ${blockers.length} 条。`,
      JSON.stringify(contentPayload),
    ],
  )

  const artifact = rows[0]
  await attachWorkItemReferences(artifact.id, items, "included_item")
  return artifact
}

function buildSummary(total: number, overdue: number, risks: number): string {
  return `本周事项中心共有 ${total} 条活跃事项，其中超期 ${overdue} 条，风险/阻塞 ${risks} 条。`
}

function buildPreMeetingSummary(meetingTitle: string, relatedItems: WorkItem[]): string {
  if (relatedItems.length === 0) {
    return `会议「${meetingTitle}」暂无匹配的未结事项，可在会后补充新的来源证据。`
  }
  const lines = relatedItems.slice(0, 5).map((item) => `- ${item.title}（${item.status}）`)
  return `会议「${meetingTitle}」关联到 ${relatedItems.length} 条未结事项：\n${lines.join("\n")}`
}

async function attachWorkItemReferences(
  artifactId: string,
  items: WorkItem[],
  relationType: "included_item" | "context" | "risk_source",
): Promise<void> {
  for (const item of items) {
    await db.execute(
      `INSERT INTO source_references
         (target_type, target_id, related_work_item_id, relation_type, excerpt, confidence_score)
       VALUES ('knowledge_artifact', $1, $2, $3, $4, $5)`,
      [artifactId, item.id, relationType, item.title, item.confidenceScore],
    )
  }
}

function toBriefItem(item: WorkItem) {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority: item.priority,
    ownerUserId: item.ownerUserId,
    dueAt: item.dueAt,
  }
}
