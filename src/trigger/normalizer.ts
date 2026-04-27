import { randomUUID } from "node:crypto"
import { log } from "../evaluation/logger.js"
import type { TriggerEvent } from "../shared/types.js"

interface RawFeishuEvent {
  event_id?: string
  event_type?: string
  type?: string
  create_time?: string
  timestamp?: string
  header?: {
    event_id?: string
    event_type?: string
    create_time?: string
  }
  event?: Record<string, unknown>
  [key: string]: unknown
}

export function normalizeFeishuEvent(raw: RawFeishuEvent): TriggerEvent {
  const eventId = raw.event_id ?? raw.header?.event_id ?? randomUUID()
  const eventType = raw.event_type ?? raw.header?.event_type ?? raw.type ?? "unknown"
  const createTime = raw.create_time ?? raw.header?.create_time ?? raw.timestamp
  const occurredAt = createTime
    ? new Date(Number(createTime.length > 13 ? Number(createTime) / 1000 : createTime) * 1000)
    : new Date()

  log.info("normalizing feishu event", { eventId, eventType })

  return {
    eventId,
    eventType,
    source: "feishu_event",
    idempotencyKey: `feishu::${eventId}`,
    payload: raw.event ?? raw,
    occurredAt,
    receivedAt: new Date(),
  }
}

export function normalizeCliCommand(command: string, args: Record<string, string>): TriggerEvent {
  return {
    eventId: randomUUID(),
    eventType: "cli",
    source: "cli",
    idempotencyKey: `cli::${randomUUID()}`,
    payload: { command, args },
    occurredAt: new Date(),
    receivedAt: new Date(),
  }
}

export function normalizeCardCallback(callbackPayload: Record<string, unknown>): TriggerEvent {
  const event = callbackPayload.event as Record<string, unknown> | undefined
  const context = event?.context as Record<string, unknown> | undefined
  const topContext = callbackPayload.context as Record<string, unknown> | undefined
  const messageId = String(context?.open_message_id ?? topContext?.open_message_id ?? callbackPayload.open_message_id ?? randomUUID())
  const action = (event?.action ?? callbackPayload.action) as { value?: { action?: string; workItemId?: string } } | undefined
  const actionName = action?.value?.action ?? "unknown"

  return {
    eventId: randomUUID(),
    eventType: "card_callback",
    source: "card_callback",
    idempotencyKey: `card_callback::${messageId}::${actionName}`,
    payload: callbackPayload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  }
}
