import { z } from "zod"
import { callLLM } from "./llm.js"
import { mapFeishuTaskStatus } from "./task-status.js"
import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import { AppError, ItemNotFoundError } from "../shared/errors.js"
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
  options: {
    changedById?: string
    sourceAssetId?: string
    sourceExcerpt?: string
    mergeAcrossSources?: boolean
  } = {},
): Promise<WorkItem[]> {
  log.info("reconciling work items", { count: extracted.length, originChannel, originContextId })

  const saved: WorkItem[] = []
  for (const item of extracted) {
    const ownerUserId = resolveOwner(item.ownerName, participants)
    const dedupeKey = generateDedupeKey(item.title, originContextId, options.mergeAcrossSources ?? false)
    const needConfirm = item.confidenceScore < 0.6

    const existing = await db.queryOne<WorkItem>(
      `SELECT * FROM work_items WHERE dedupe_key = $1 AND deleted_at IS NULL`,
      [dedupeKey],
    )

    if (existing) {
      log.info("merging with existing item", { existingId: existing.id, newTitle: item.title })
      const isCrossSourceMerge = existing.originChannel !== originChannel || existing.originContextId !== originContextId
      const updated = await db.query<WorkItem>(
        `UPDATE work_items SET
           last_detected_at = now(), updated_at = now(),
           confidence_score = GREATEST(confidence_score, $2),
           need_human_confirm = need_human_confirm OR $3
         WHERE id = $1 RETURNING *`,
        [existing.id, item.confidenceScore, isCrossSourceMerge],
      )
      await attachSourceReference(updated[0].id, options, item.confidenceScore, "evidence_for")
      await db.execute(
        `INSERT INTO work_item_audit_log
           (work_item_id, change_type, to_value, reason, changed_by_type, changed_by_id)
         VALUES ($1, 'merge', $2, $3, 'workflow', $4)`,
        [
          existing.id,
          `${originChannel}:${originContextId}`,
          isCrossSourceMerge ? "possible cross-source duplicate merged" : "duplicate source item detected",
          options.changedById ?? "reconcile-and-save",
        ],
      )
      if (isCrossSourceMerge) {
        await ensureHumanReviewTask(
          existing.id,
          `请确认来自 ${originChannel}:${originContextId} 的事项是否应与现有事项合并。`,
        )
      }
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
      await attachSourceReference(created[0].id, options, item.confidenceScore, "derived_from")

      await db.execute(
        `INSERT INTO work_item_audit_log
           (work_item_id, change_type, to_value, reason, changed_by_type, changed_by_id)
         VALUES ($1, 'create', $2, $4, 'workflow', $3)`,
        [
          created[0].id,
          item.itemType,
          options.changedById ?? "reconcile-and-save",
          `auto-extracted from ${originChannel}`,
        ],
      )
      if (needConfirm) {
        await ensureHumanReviewTask(created[0].id, "抽取置信度较低，需要人工确认。")
      }
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
  new: ["pending_review", "active", "done", "closed"],
  pending_review: ["active", "done", "closed"],
  active: ["blocked", "done", "closed"],
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
    throw new AppError("Invalid WorkItem status transition", "INVALID_STATUS_TRANSITION", {
      workItemId,
      from: item.status,
      to: newStatus,
    })
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

export async function listActiveItems(filters?: {
  ownerUserId?: string
  itemType?: string
  limit?: number
}): Promise<WorkItem[]> {
  const conditions = ["deleted_at IS NULL", "status IN ('new', 'pending_review', 'active', 'blocked')"]
  const params: unknown[] = []
  let idx = 1

  if (filters?.ownerUserId) {
    conditions.push(`owner_user_id = $${idx++}`)
    params.push(filters.ownerUserId)
  }

  if (filters?.itemType) {
    conditions.push(`item_type = $${idx++}`)
    params.push(filters.itemType)
  }

  const limit = filters?.limit ?? 200
  params.push(limit)

  return db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE ${conditions.join(" AND ")}
     ORDER BY COALESCE(due_at, created_at) ASC
     LIMIT $${idx}`,
    params,
  )
}

export async function syncExternalTaskStatuses(statuses: Map<string, string>): Promise<WorkItem[]> {
  const changed: WorkItem[] = []

  for (const [taskId, externalStatus] of statuses.entries()) {
    const result = await syncExternalTaskStatus(taskId, externalStatus)
    if (result.action === "updated" && result.item) changed.push(result.item)
  }

  log.info("external task statuses synced", { changedCount: changed.length })
  return changed
}

export type FeishuTaskSyncResult =
  | {
    action: "updated"
    taskId: string
    workItemId: string
    externalStatus: string
    fromStatus: ItemStatus
    toStatus: ItemStatus
    item: WorkItem
  }
  | {
    action: "unchanged" | "ignored"
    taskId: string
    workItemId?: string
    externalStatus: string
    currentStatus?: ItemStatus
    mappedStatus?: ItemStatus
    reason?: string
  }

export async function syncExternalTaskStatus(
  taskId: string,
  externalStatus: string,
): Promise<FeishuTaskSyncResult> {
  const binding = await db.queryOne<{ id: string; workItemId: string }>(
    `SELECT id, work_item_id FROM task_bindings
     WHERE binding_type = 'feishu_task' AND external_id = $1
     ORDER BY is_primary DESC, created_at DESC
     LIMIT 1`,
    [taskId],
  )

  if (!binding) {
    log.warn("feishu task update ignored because no work item binding was found", { taskId, externalStatus })
    return { action: "ignored", taskId, externalStatus, reason: "missing_feishu_task_binding" }
  }

  const item = await findById(binding.workItemId)
  if (!item) {
    await markTaskBindingSync(binding.id, "failed", "bound work item not found")
    log.warn("feishu task update ignored because bound work item was not found", {
      taskId,
      workItemId: binding.workItemId,
    })
    return {
      action: "ignored",
      taskId,
      workItemId: binding.workItemId,
      externalStatus,
      reason: "bound_work_item_missing",
    }
  }

  const nextStatus = mapFeishuTaskStatus(externalStatus, item.status)
  if (!nextStatus) {
    await markTaskBindingSync(binding.id, "conflict", `unmapped feishu task status: ${externalStatus}`)
    log.info("feishu task status left unchanged because status is unmapped", {
      taskId,
      workItemId: item.id,
      externalStatus,
      currentStatus: item.status,
    })
    return {
      action: "ignored",
      taskId,
      workItemId: item.id,
      externalStatus,
      currentStatus: item.status,
      reason: "unmapped_status",
    }
  }

  await markTaskBindingSync(binding.id, "synced")
  await markWorkItemSynced(item.id)

  if (nextStatus === item.status) {
    return {
      action: "unchanged",
      taskId,
      workItemId: item.id,
      externalStatus,
      currentStatus: item.status,
      mappedStatus: nextStatus,
    }
  }

  const updated = await updateStatus(
    item.id,
    nextStatus,
    { type: "sync", id: `feishu_task:${taskId}` },
    `synced from feishu task status: ${externalStatus}`,
  )

  return {
    action: "updated",
    taskId,
    workItemId: item.id,
    externalStatus,
    fromStatus: item.status,
    toStatus: nextStatus,
    item: updated,
  }
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

async function attachSourceReference(
  workItemId: string,
  options: { sourceAssetId?: string; sourceExcerpt?: string },
  confidenceScore: number,
  relationType: "derived_from" | "evidence_for",
): Promise<void> {
  if (!options.sourceAssetId && !options.sourceExcerpt) return

  await db.execute(
    `INSERT INTO source_references
       (target_type, target_id, asset_id, relation_type, excerpt, confidence_score)
     VALUES ('work_item', $1, $2, $3, $4, $5)`,
    [
      workItemId,
      options.sourceAssetId ?? null,
      relationType,
      options.sourceExcerpt ?? null,
      confidenceScore,
    ],
  )
}

async function ensureHumanReviewTask(workItemId: string, reason: string): Promise<void> {
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM human_review_tasks
     WHERE target_type = 'work_item'
       AND target_id = $1
       AND review_status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [workItemId],
  )
  if (existing) return

  const created = await db.query<{ id: string }>(
    `INSERT INTO human_review_tasks (target_type, target_id, review_reason)
     VALUES ('work_item', $1, $2)
     RETURNING id`,
    [workItemId, reason],
  )

  await db.execute(
    `UPDATE work_items
     SET current_review_task_id = $2, updated_at = now()
     WHERE id = $1`,
    [workItemId, created[0]?.id ?? null],
  )
}

function generateDedupeKey(title: string, contextId: string, mergeAcrossSources: boolean): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)
  if (mergeAcrossSources) return `global::${normalized}`
  return `${contextId}::${normalized}`
}

export { mapFeishuTaskStatus } from "./task-status.js"

async function markTaskBindingSync(
  bindingId: string,
  syncStatus: "synced" | "conflict" | "failed",
  error?: string,
): Promise<void> {
  await db.execute(
    `UPDATE task_bindings
     SET sync_status = $2,
         last_sync_at = now(),
         last_sync_error = $3,
         updated_at = now()
     WHERE id = $1`,
    [bindingId, syncStatus, error ?? null],
  )
}

async function markWorkItemSynced(workItemId: string): Promise<void> {
  await db.execute(
    `UPDATE work_items
     SET last_synced_at = now(),
         last_touched_by_workflow = 'feishu-task-sync',
         updated_at = now()
     WHERE id = $1`,
    [workItemId],
  )
}
