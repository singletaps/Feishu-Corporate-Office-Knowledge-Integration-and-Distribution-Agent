import { db } from "../shared/db.js"
import { createFeishuTask } from "../integration/task.js"
import { findById, updateStatus } from "../domain/work-item.js"
import { projectWorkItemsToBase } from "../integration/base.js"
import { acknowledgePushRecordByMessage } from "../evaluation/push-records.js"
import { AppError } from "../shared/errors.js"
import { assertHubPermission, ensurePrimaryProjection, resolveHubForChat, writeHubAudit } from "./hub-service.js"
import type { WorkItem } from "../shared/types.js"

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
  const action = value.action ?? inferActionFromName(actionName)
  const workItemId = value.workItemId ?? null
  const actorId = event?.operator?.open_id ?? payload.operator?.open_id ?? payload.open_id ?? "unknown"
  const messageId = event?.context?.open_message_id ?? payload.context?.open_message_id ?? payload.open_message_id
  const chatId = event?.context?.open_chat_id ?? payload.context?.open_chat_id

  if (messageId) {
    await acknowledgePushRecordByMessage(messageId)
  }

  if ((action === "confirm" || action === "workitem.confirm") && workItemId) {
    const item = await updateStatus(workItemId, "active", { type: "human", id: actorId }, "confirmed from card")
    const taskCreated = await createTaskForConfirmedItem(item.id)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated }
  }

  if ((action === "reject" || action === "workitem.reject") && workItemId) {
    const item = await updateStatus(workItemId, "closed", { type: "human", id: actorId }, "rejected from card")
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  if (action === "workitem.submit_draft") {
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

async function createWorkItemFromDraft(
  value: Record<string, unknown>,
  formValue: Record<string, unknown>,
  actorId: string,
  chatId?: string,
): Promise<WorkItem> {
  const hubId = stringValue(value.hubId) || await resolveHubIdForDraft(chatId, actorId)
  if (!hubId) throw new AppError("Missing Hub ID in draft card", "CARD_MISSING_HUB", { value, chatId })
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

async function markWorkItemDone(workItemId: string, hubId: unknown, actorId: string): Promise<WorkItem> {
  const resolvedHubId = stringValue(hubId)
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
  return ""
}

async function resolveHubIdForDraft(chatId: string | undefined, actorId: string): Promise<string | null> {
  if (!chatId) return null
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
