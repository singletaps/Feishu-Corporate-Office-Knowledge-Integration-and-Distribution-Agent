import { db } from "../shared/db.js"
import { createFeishuTask } from "../integration/task.js"
import { findById, updateStatus } from "../domain/work-item.js"
import { acknowledgePushRecordByMessage } from "../evaluation/push-records.js"
import { AppError } from "../shared/errors.js"

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
      }
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
    }
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
  const value = event?.action?.value ?? payload.action?.value ?? {}
  const action = value.action ?? ""
  const workItemId = value.workItemId ?? null
  const actorId = event?.operator?.open_id ?? payload.operator?.open_id ?? payload.open_id ?? "unknown"
  const messageId = event?.context?.open_message_id ?? payload.context?.open_message_id ?? payload.open_message_id

  if (messageId) {
    await acknowledgePushRecordByMessage(messageId)
  }

  if (action === "confirm" && workItemId) {
    const item = await updateStatus(workItemId, "active", { type: "human", id: actorId }, "confirmed from card")
    const taskCreated = await createTaskForConfirmedItem(item.id)
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated }
  }

  if (action === "reject" && workItemId) {
    const item = await updateStatus(workItemId, "closed", { type: "human", id: actorId }, "rejected from card")
    return { ok: true, action, workItemId, newStatus: item.status, taskCreated: null }
  }

  throw new AppError(`Unsupported card action: ${action || "(empty)"}`, "UNSUPPORTED_CARD_ACTION", {
    action,
    workItemId,
  })
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
