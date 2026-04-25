import { z } from "zod"
import { callLLM } from "./llm.js"
import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import { ItemNotFoundError } from "../shared/errors.js"
import type {
  WorkItem, ExtractedWorkItem, FeishuUser,
  OriginChannel, ItemStatus, ChangedBy,
} from "../shared/types.js"

// ----- Zod schemas for LLM output -----

const extractedItemSchema = z.object({
  title: z.string(),
  itemType: z.enum(["todo", "decision", "risk", "blocker"]),
  ownerName: z.string().nullable(),
  dueAt: z.string().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]).nullable(),
  confidenceScore: z.number().min(0).max(1),
  reasoning: z.string().optional(),
})

const extractionResultSchema = z.object({
  items: z.array(extractedItemSchema),
})

// ----- Extraction -----

export async function extractWorkItems(
  content: string,
  participants: FeishuUser[],
  originChannel: OriginChannel,
  originContextId: string,
): Promise<ExtractedWorkItem[]> {
  log.info("extracting work items", { originChannel, originContextId, contentLength: content.length })

  const participantNames = participants.map((p) => p.name).filter(Boolean)

  const result = await callLLM(
    "extract-work-items",
    { content, participantNames: participantNames.join(", ") },
    extractionResultSchema,
  )

  log.info("extraction complete", {
    count: result.data.items.length,
    tokenUsage: result.tokenUsage,
  })

  return result.data.items.map((item) => ({
    title: item.title,
    itemType: item.itemType,
    ownerName: item.ownerName,
    dueAt: item.dueAt,
    priority: item.priority,
    confidenceScore: item.confidenceScore,
    metadata: item.reasoning ? { reasoning: item.reasoning } : {},
  }))
}

// ----- Reconcile and save -----

export async function reconcileAndSave(
  extracted: ExtractedWorkItem[],
  originChannel: OriginChannel,
  originContextId: string,
  participants: FeishuUser[],
): Promise<WorkItem[]> {
  log.info("reconciling work items", { count: extracted.length, originChannel, originContextId })

  const saved: WorkItem[] = []
  for (const item of extracted) {
    const ownerUserId = resolveOwner(item.ownerName, participants)
    const dedupeKey = generateDedupeKey(item.title, originContextId)
    const needConfirm = item.confidenceScore < 0.6

    const existing = await db.queryOne<WorkItem>(
      `SELECT * FROM work_items WHERE dedupe_key = $1 AND deleted_at IS NULL`,
      [dedupeKey],
    )

    if (existing) {
      log.info("merging with existing item", { existingId: existing.id, newTitle: item.title })
      const updated = await db.query<WorkItem>(
        `UPDATE work_items SET
           last_detected_at = now(), updated_at = now(),
           confidence_score = GREATEST(confidence_score, $2)
         WHERE id = $1 RETURNING *`,
        [existing.id, item.confidenceScore],
      )
      saved.push(updated[0])
    } else {
      log.info("creating new item", { title: item.title, itemType: item.itemType })
      const created = await db.query<WorkItem>(
        `INSERT INTO work_items
           (title, item_type, status, priority, owner_user_id, owner_source, due_at,
            confidence_score, need_human_confirm, origin_channel, origin_context_id,
            dedupe_key, metadata, first_detected_at, last_detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
         RETURNING *`,
        [
          item.title,
          item.itemType,
          needConfirm ? "pending_review" : "new",
          item.priority,
          ownerUserId,
          ownerUserId ? "inferred" : null,
          item.dueAt ? new Date(item.dueAt) : null,
          item.confidenceScore,
          needConfirm,
          originChannel,
          originContextId,
          dedupeKey,
          JSON.stringify(item.metadata),
        ],
      )
      saved.push(created[0])

      await db.execute(
        `INSERT INTO work_item_audit_log
           (work_item_id, change_type, to_value, reason, changed_by_type, changed_by_id)
         VALUES ($1, 'create', $2, 'auto-extracted from meeting', 'workflow', 'post-meeting-extraction')`,
        [created[0].id, item.itemType],
      )
    }
  }

  log.info("reconciliation complete", {
    savedCount: saved.length,
    newCount: saved.filter((s) => s.status === "new" || s.status === "pending_review").length,
  })

  return saved
}

// ----- Status update -----

const VALID_TRANSITIONS: Record<string, string[]> = {
  new: ["pending_review", "active"],
  pending_review: ["active", "closed"],
  active: ["blocked", "done"],
  blocked: ["active", "closed"],
  done: ["closed"],
}

export async function updateStatus(
  workItemId: string,
  newStatus: ItemStatus,
  changedBy: ChangedBy,
  reason?: string,
): Promise<WorkItem> {
  const item = await db.queryOne<WorkItem>(`SELECT * FROM work_items WHERE id = $1`, [workItemId])
  if (!item) throw new ItemNotFoundError(workItemId)

  const allowed = VALID_TRANSITIONS[item.status] ?? []
  if (!allowed.includes(newStatus)) {
    log.warn("invalid status transition", { workItemId, from: item.status, to: newStatus })
  }

  log.info("updating work item status", { workItemId, from: item.status, to: newStatus })

  const updated = await db.query<WorkItem>(
    `UPDATE work_items SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [workItemId, newStatus],
  )

  await db.execute(
    `INSERT INTO work_item_audit_log
       (work_item_id, change_type, field_name, from_value, to_value, reason, changed_by_type, changed_by_id)
     VALUES ($1, 'status_change', 'status', $2, $3, $4, $5, $6)`,
    [workItemId, item.status, newStatus, reason ?? null, changedBy.type, changedBy.id],
  )

  return updated[0]
}

// ----- Field update -----

export async function update(
  workItemId: string,
  fields: Partial<Pick<WorkItem, "title" | "priority" | "ownerUserId" | "dueAt" | "metadata">>,
  changedBy: ChangedBy,
): Promise<WorkItem> {
  const item = await db.queryOne<WorkItem>(`SELECT * FROM work_items WHERE id = $1`, [workItemId])
  if (!item) throw new ItemNotFoundError(workItemId)

  const setClauses: string[] = ["updated_at = now()"]
  const params: unknown[] = []
  let paramIdx = 1

  if (fields.title !== undefined) {
    setClauses.push(`title = $${paramIdx++}`)
    params.push(fields.title)
  }
  if (fields.priority !== undefined) {
    setClauses.push(`priority = $${paramIdx++}`)
    params.push(fields.priority)
  }
  if (fields.ownerUserId !== undefined) {
    setClauses.push(`owner_user_id = $${paramIdx++}`)
    params.push(fields.ownerUserId)
    setClauses.push(`owner_source = 'manual'`)
  }
  if (fields.dueAt !== undefined) {
    setClauses.push(`due_at = $${paramIdx++}`)
    params.push(fields.dueAt)
  }
  if (fields.metadata !== undefined) {
    setClauses.push(`metadata = $${paramIdx++}`)
    params.push(JSON.stringify(fields.metadata))
  }

  params.push(workItemId)
  const updated = await db.query<WorkItem>(
    `UPDATE work_items SET ${setClauses.join(", ")} WHERE id = $${paramIdx} RETURNING *`,
    params,
  )

  log.info("work item updated", { workItemId, fields: Object.keys(fields) })
  return updated[0]
}

// ----- Queries -----

export async function findById(workItemId: string): Promise<WorkItem | null> {
  return db.queryOne<WorkItem>(`SELECT * FROM work_items WHERE id = $1 AND deleted_at IS NULL`, [workItemId])
}

export async function findOverdueAndBlocked(): Promise<{ overdue: WorkItem[]; blocked: WorkItem[] }> {
  const overdue = await db.query<WorkItem>(
    `SELECT * FROM work_items WHERE status = 'active' AND due_at < now() AND deleted_at IS NULL ORDER BY due_at`,
  )
  const blocked = await db.query<WorkItem>(
    `SELECT * FROM work_items WHERE status = 'blocked' AND deleted_at IS NULL ORDER BY updated_at`,
  )
  log.info("found risky items", { overdueCount: overdue.length, blockedCount: blocked.length })
  return { overdue, blocked }
}

export async function listByOrigin(originContextId: string): Promise<WorkItem[]> {
  return db.query<WorkItem>(
    `SELECT * FROM work_items WHERE origin_context_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [originContextId],
  )
}

// ----- Helpers -----

function resolveOwner(ownerName: string | null, participants: FeishuUser[]): string | null {
  if (!ownerName) return null
  const match = participants.find(
    (p) => p.name === ownerName || p.name.includes(ownerName) || ownerName.includes(p.name),
  )
  return match?.openId ?? null
}

function generateDedupeKey(title: string, contextId: string): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)
  return `${contextId}::${normalized}`
}
