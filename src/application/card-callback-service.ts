import { db } from "../shared/db.js"
import { createFeishuTask } from "../integration/task.js"
import { findById, update as updateWorkItem, updateStatus } from "../domain/work-item.js"
import { recordPushInteractionByMessage } from "../evaluation/push-records.js"
import { AppError } from "../shared/errors.js"
import type { ItemStatus, WorkItem } from "../shared/types.js"

export interface CardCallbackPayload {
  schema?: string
  header?: {
    token?: string
    event_type?: string
  }
  event?: {
    operator?: {
      open_id?: string
    }
    action?: {
      value?: {
        action?: string
        workItemId?: string
        workItemIds?: string[] | string
        hubId?: string
        actorOpenId?: string
        draftTitle?: string
        days?: number
      }
      name?: string
      form_value?: Record<string, unknown>
    }
    context?: {
      open_message_id?: string
      open_chat_id?: string
    }
  }
  operator?: {
    open_id?: string
  }
  context?: {
    open_message_id?: string
    open_chat_id?: string
  }
  open_id?: string
  open_message_id?: string
  action?: {
    value?: {
      action?: string
      workItemId?: string
      workItemIds?: string[] | string
      hubId?: string
      actorOpenId?: string
      draftTitle?: string
      days?: number
    }
    name?: string
    form_value?: Record<string, unknown>
  }
}

export async function handleCardCallback(payload: CardCallbackPayload): Promise<{
  ok: true
  action: string
  workItemId: string | null
  newStatus: string | null
  taskCreated: string | null
}> {
  const event = payload.event
  const actionPayload = event?.action ?? payload.action
  const value = actionPayload?.value ?? {}
  const formValue = actionPayload?.form_value ?? {}
  const actionName = actionPayload?.name ?? ""
  const rawAction = stringValue(value.action) || inferActionFromName(actionName)
  const action = normalizeCardAction(rawAction)
  const workItemId = value.workItemId ?? null
  const actorId = event?.operator?.open_id ?? payload.operator?.open_id ?? payload.open_id ?? "unknown"
  const messageId = event?.context?.open_message_id ?? payload.context?.open_message_id ?? payload.open_message_id
  const chatId = event?.context?.open_chat_id ?? payload.context?.open_chat_id

  if (messageId) {
    await recordPushInteractionByMessage(messageId, { action, actorId, workItemId })
  }

  if (action === "workitem.confirm" && workItemId) {
    const item = await confirmWorkItem(workItemId, actorId)
    const taskCreated = await createTaskForConfirmedItem(item.id)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated }
  }

  if (action === "workitem.confirm_all") {
    const workItemIds = readWorkItemIds(value)
    if (workItemIds.length === 0) {
      throw new AppError("Missing WorkItem IDs for confirm_all", "CARD_MISSING_WORK_ITEM_IDS", { value })
    }
    let lastItem: WorkItem | null = null
    let taskCreated: string | null = null
    for (const id of workItemIds) {
      lastItem = await confirmWorkItem(id, actorId)
      taskCreated = await createTaskForConfirmedItem(id) ?? taskCreated
    }
    return {
      ok: true,
      action,
      workItemId: workItemIds.join(","),
      newStatus: lastItem?.status ?? null,
      taskCreated,
    }
  }

  if (action === "workitem.reject" && workItemId) {
    const item = await rejectWorkItem(workItemId, actorId)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.edit" && workItemId) {
    const item = await reviseWorkItem(workItemId, formValue, actorId)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.claim_risk" && workItemId) {
    const item = await claimRiskWorkItem(workItemId, actorId)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.submit_draft" || action === "workitem.add_missing") {
    const item = await createWorkItemFromDraft(value, formValue, actorId, chatId)
    return { ok: true, action, workItemId: item.id, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.mark_done" && workItemId) {
    const item = await markWorkItemDone(workItemId, value.hubId, actorId)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.delay" && workItemId) {
    const item = await delayWorkItem(workItemId, value.hubId, Number(value.days ?? 1), actorId)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  throw new AppError(`Unsupported card action: ${action || "(empty)"}`, "UNSUPPORTED_CARD_ACTION", {
    action,
    workItemId,
  })
}

async function confirmWorkItem(workItemId: string, actorId: string): Promise<WorkItem> {
  const item = await setStatusIfNeeded(workItemId, "active", actorId, "confirmed from card")
  await closeHumanReview(workItemId, "approved", actorId, "confirmed from card")
  return await findById(workItemId) ?? item
}

async function rejectWorkItem(workItemId: string, actorId: string): Promise<WorkItem> {
  const item = await setStatusIfNeeded(workItemId, "closed", actorId, "rejected from card")
  await closeHumanReview(workItemId, "rejected", actorId, "rejected from card")
  return await findById(workItemId) ?? item
}

async function reviseWorkItem(
  workItemId: string,
  formValue: Record<string, unknown>,
  actorId: string,
): Promise<WorkItem> {
  const before = await requireWorkItem(workItemId)
  const fields = readEditableFields(formValue, before)
  if (Object.keys(fields).length === 0) {
    throw new AppError("No editable WorkItem fields in card callback", "CARD_EMPTY_EDIT", { workItemId })
  }

  const updated = await updateWorkItem(workItemId, fields, { type: "human", id: actorId })
  await writeFieldAuditEntries(before, updated, fields, actorId, "revised from card")
  await closeHumanReview(workItemId, "revised", actorId, "revised from card")

  if (updated.status === "new" || updated.status === "pending_review") {
    return setStatusIfNeeded(workItemId, "active", actorId, "revised from card")
  }
  return await findById(workItemId) ?? updated
}

async function claimRiskWorkItem(workItemId: string, actorId: string): Promise<WorkItem> {
  const before = await requireWorkItem(workItemId)
  const updated = await updateWorkItem(workItemId, { ownerUserId: actorId }, { type: "human", id: actorId })
  await writeFieldAuditEntries(before, updated, { ownerUserId: actorId }, actorId, "risk claimed from card")
  await closeHumanReview(workItemId, "approved", actorId, "risk claimed from card")

  if (updated.status === "new" || updated.status === "pending_review") {
    return setStatusIfNeeded(workItemId, "active", actorId, "risk claimed from card")
  }
  return await findById(workItemId) ?? updated
}

async function createWorkItemFromDraft(
  value: Record<string, unknown>,
  formValue: Record<string, unknown>,
  actorId: string,
  chatId?: string,
): Promise<WorkItem> {
  const hubId = stringValue(value.hubId) || await resolveHubIdForDraft(chatId, actorId)
  if (!hubId) throw new AppError("Missing Hub ID in draft card", "CARD_MISSING_HUB", { value, chatId })
  const { assertHubPermission, ensurePrimaryProjection, writeHubAudit } = await import("./hub-service.js")
  const { projectWorkItemsToBase } = await import("../integration/base.js")
  await assertHubPermission(actorId, hubId, "item:write")

  const title = stringValue(formValue.title) || stringValue(value.draftTitle)
  if (!title) throw new AppError("WorkItem title is required", "CARD_MISSING_TITLE", { hubId })

  const itemType = enumValue(formValue.itemType, ["todo", "decision", "risk", "blocker"], "todo")
  const priority = enumValue(formValue.priority, ["low", "medium", "high", "critical"], "medium")
  const ownerUserId = stringValue(formValue.ownerUserId) || actorId
  const detail = stringValue(formValue.detail)
  const startDate = dateValue(formValue.startDate)
  const dueAt = dateValue(formValue.dueDate)
  const originContextId = `card-draft:${Date.now()}`
  const rows = await db.query<WorkItem>(
    `INSERT INTO work_items
       (title, item_type, status, priority, owner_user_id, owner_source, due_at,
        confidence_score, need_human_confirm, origin_channel, origin_context_id,
        dedupe_key, metadata, first_detected_at, last_detected_at)
     VALUES ($1, $2, 'new', $3, $4, 'manual', $5, 1, false, 'im', $6, $7, $8, now(), now())
     RETURNING *`,
    [
      title,
      itemType,
      priority,
      ownerUserId,
      dueAt,
      originContextId,
      `hub:${hubId}:${title.trim().toLowerCase()}`,
      JSON.stringify({ source: "workitem_draft_card", detail, startDate }),
    ],
  )
  await ensurePrimaryProjection(rows[0].id, hubId)
  await projectWorkItemsToBase(rows, { hubId })
  await writeHubAudit({
    hubId,
    actorOpenId: actorId,
    action: "card_submit_draft",
    targetType: "work_item",
    targetId: rows[0].id,
    payload: { title, itemType, priority, ownerUserId, dueAt, startDate },
  })
  return rows[0]
}

async function requireWorkItem(workItemId: string): Promise<WorkItem> {
  const item = await findById(workItemId)
  if (!item) throw new AppError("WorkItem not found", "ITEM_NOT_FOUND", { workItemId })
  return item
}

async function setStatusIfNeeded(
  workItemId: string,
  newStatus: ItemStatus,
  actorId: string,
  reason: string,
): Promise<WorkItem> {
  const item = await requireWorkItem(workItemId)
  if (item.status === newStatus) return item
  return updateStatus(workItemId, newStatus, { type: "human", id: actorId }, reason)
}

async function closeHumanReview(
  workItemId: string,
  reviewStatus: "approved" | "rejected" | "revised",
  actorId: string,
  reason: string,
): Promise<void> {
  const item = await requireWorkItem(workItemId)
  await db.execute(
    `UPDATE human_review_tasks
     SET review_status = $2, assigned_reviewer = COALESCE(assigned_reviewer, $3), reviewed_at = now()
     WHERE target_type = 'work_item'
       AND target_id = $1
       AND review_status = 'pending'`,
    [workItemId, reviewStatus, actorId],
  )

  if (item.needHumanConfirm || item.currentReviewTaskId) {
    await db.execute(
      `UPDATE work_items
       SET need_human_confirm = false,
           current_review_task_id = NULL,
           updated_at = now()
       WHERE id = $1`,
      [workItemId],
    )
    await db.execute(
      `INSERT INTO work_item_audit_log
         (work_item_id, change_type, field_name, from_value, to_value, reason, changed_by_type, changed_by_id)
       VALUES ($1, 'field_update', 'need_human_confirm', $2, 'false', $3, 'human', $4)`,
      [workItemId, String(item.needHumanConfirm), reason, actorId],
    )
  }
}

function readEditableFields(
  formValue: Record<string, unknown>,
  before: WorkItem,
): Partial<Pick<WorkItem, "title" | "priority" | "ownerUserId" | "dueAt" | "metadata">> {
  const fields: Partial<Pick<WorkItem, "title" | "priority" | "ownerUserId" | "dueAt" | "metadata">> = {}
  const title = stringValue(formValue.title)
  const priority = enumValue(formValue.priority, ["low", "medium", "high", "critical"], before.priority ?? "medium")
  const ownerUserId = stringValue(formValue.ownerUserId)
  const dueAt = dateValue(formValue.dueDate ?? formValue.dueAt)
  const detail = stringValue(formValue.detail)

  if (title && title !== before.title) fields.title = title
  if (stringValue(formValue.priority) && priority !== before.priority) fields.priority = priority
  if (ownerUserId && ownerUserId !== before.ownerUserId) fields.ownerUserId = ownerUserId
  if (formValue.dueDate !== undefined || formValue.dueAt !== undefined) fields.dueAt = dueAt
  if (detail && detail !== before.metadata?.detail) fields.metadata = { ...before.metadata, detail }

  return fields
}

async function writeFieldAuditEntries(
  before: WorkItem,
  after: WorkItem,
  fields: Partial<Pick<WorkItem, "title" | "priority" | "ownerUserId" | "dueAt" | "metadata">>,
  actorId: string,
  reason: string,
): Promise<void> {
  for (const fieldName of Object.keys(fields) as Array<keyof typeof fields>) {
    const fromValue = serializeAuditValue(before[fieldName])
    const toValue = serializeAuditValue(after[fieldName])
    if (fromValue === toValue) continue
    await db.execute(
      `INSERT INTO work_item_audit_log
         (work_item_id, change_type, field_name, from_value, to_value, reason, changed_by_type, changed_by_id)
       VALUES ($1, 'field_update', $2, $3, $4, $5, 'human', $6)`,
      [before.id, toSnakeFieldName(fieldName), fromValue, toValue, reason, actorId],
    )
  }
}

function readWorkItemIds(value: Record<string, unknown>): string[] {
  const raw = value.workItemIds ?? value.workItemId
  if (Array.isArray(raw)) return raw.map(stringValue).filter(Boolean)
  return stringValue(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
}

async function markWorkItemDone(workItemId: string, hubId: unknown, actorId: string): Promise<WorkItem> {
  const resolvedHubId = stringValue(hubId)
  const { assertHubPermission, writeHubAudit } = await import("./hub-service.js")
  const { projectWorkItemsToBase } = await import("../integration/base.js")
  if (resolvedHubId) await assertHubPermission(actorId, resolvedHubId, "item:write")
  const rows = await db.query<WorkItem>(
    `UPDATE work_items
     SET status = 'done', updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [workItemId],
  )
  if (!rows[0]) throw new AppError("WorkItem not found", "ITEM_NOT_FOUND", { workItemId })
  await projectWorkItemsToBase(rows, { hubId: resolvedHubId || undefined })
  await writeHubAudit({
    hubId: resolvedHubId || null,
    actorOpenId: actorId,
    action: "card_mark_done",
    targetType: "work_item",
    targetId: workItemId,
  })
  return rows[0]
}

async function delayWorkItem(workItemId: string, hubId: unknown, days: number, actorId: string): Promise<WorkItem> {
  const resolvedHubId = stringValue(hubId)
  const { assertHubPermission, writeHubAudit } = await import("./hub-service.js")
  const { projectWorkItemsToBase } = await import("../integration/base.js")
  if (resolvedHubId) await assertHubPermission(actorId, resolvedHubId, "item:write")
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 30) : 1
  const rows = await db.query<WorkItem>(
    `UPDATE work_items
     SET due_at = COALESCE(due_at, now()) + ($2 || ' days')::interval,
         updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [workItemId, safeDays],
  )
  if (!rows[0]) throw new AppError("WorkItem not found", "ITEM_NOT_FOUND", { workItemId })
  await projectWorkItemsToBase(rows, { hubId: resolvedHubId || undefined })
  await writeHubAudit({
    hubId: resolvedHubId || null,
    actorOpenId: actorId,
    action: "card_delay",
    targetType: "work_item",
    targetId: workItemId,
    payload: { days: safeDays, dueAt: rows[0].dueAt },
  })
  return rows[0]
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return stringValue(obj.value ?? obj.text ?? obj.date)
  }
  return ""
}

function dateValue(value: unknown): Date | null {
  const raw = stringValue(value)
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function enumValue<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  const raw = stringValue(value) as T
  return allowed.includes(raw) ? raw : fallback
}

function inferActionFromName(name: string): string {
  if (name === "submitDraft") return "workitem.submit_draft"
  if (name === "editWorkItem") return "workitem.edit"
  if (name === "claimRisk") return "workitem.claim_risk"
  return ""
}

function normalizeCardAction(action: string): string {
  const normalized = action.trim().toLowerCase()
  const aliases: Record<string, string> = {
    confirm: "workitem.confirm",
    confirmed: "workitem.confirm",
    approve: "workitem.confirm",
    approved: "workitem.confirm",
    "workitem.approve": "workitem.confirm",
    reject: "workitem.reject",
    rejected: "workitem.reject",
    deny: "workitem.reject",
    denied: "workitem.reject",
    "workitem.deny": "workitem.reject",
    edit: "workitem.edit",
    modify: "workitem.edit",
    modified: "workitem.edit",
    "workitem.modify": "workitem.edit",
    "workitem.revise": "workitem.edit",
    claim: "workitem.claim_risk",
    claimed: "workitem.claim_risk",
    "risk.claim": "workitem.claim_risk",
    "workitem.claim": "workitem.claim_risk",
    add_missing: "workitem.add_missing",
    "workitem.add": "workitem.add_missing",
  }
  return aliases[normalized] ?? normalized
}

function serializeAuditValue(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

function toSnakeFieldName(fieldName: string): string {
  return fieldName.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
}

async function resolveHubIdForDraft(chatId: string | undefined, actorId: string): Promise<string | null> {
  if (!chatId) return null
  const { resolveHubForChat } = await import("./hub-service.js")
  const hub = await resolveHubForChat(chatId, actorId === "unknown" ? undefined : actorId)
  return hub.id
}

async function createTaskForConfirmedItem(workItemId: string): Promise<string | null> {
  const item = await findById(workItemId)
  if (!item || item.itemType !== "todo" || !item.ownerUserId) return null

  const existing = await db.queryOne<{ externalId: string }>(
    `SELECT external_id FROM task_bindings
     WHERE work_item_id = $1 AND binding_type = 'feishu_task'
     ORDER BY created_at DESC LIMIT 1`,
    [workItemId],
  )
  if (existing?.externalId) return existing.externalId

  const result = await createFeishuTask({
    title: item.title,
    ownerOpenId: item.ownerUserId,
    dueAt: item.dueAt,
    description: `来源: ${item.originChannel}:${item.originContextId}`,
    sourceLink: null,
  })
  if (!result.taskId) return null

  await db.execute(
    `INSERT INTO task_bindings (work_item_id, binding_type, external_id, is_primary, binding_role, sync_status)
     VALUES ($1, 'feishu_task', $2, true, 'execution', 'synced')
     ON CONFLICT DO NOTHING`,
    [workItemId, result.taskId],
  )

  return result.taskId
}
