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

  return rows[0]
}

function buildSummary(total: number, overdue: number, risks: number): string {
  return `本周事项中心共有 ${total} 条活跃事项，其中超期 ${overdue} 条，风险/阻塞 ${risks} 条。`
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
