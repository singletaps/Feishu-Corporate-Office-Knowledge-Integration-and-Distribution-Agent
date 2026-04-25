import { randomUUID } from "node:crypto"
import { log } from "../evaluation/logger.js"
import type { TriggerEvent } from "../shared/types.js"

interface RawFeishuEvent {
  event_id?: string
  event_type?: string
  create_time?: string
  event?: Record<string, unknown>
  [key: string]: unknown
}

export function normalizeFeishuEvent(raw: RawFeishuEvent): TriggerEvent {
  const eventId = raw.event_id ?? randomUUID()
  const eventType = raw.event_type ?? "unknown"
  const occurredAt = raw.create_time
    ? new Date(Number(raw.create_time) * 1000)
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
