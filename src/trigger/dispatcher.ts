import { tasks } from "@trigger.dev/sdk"
import { redis } from "../shared/redis.js"
import { log } from "../evaluation/logger.js"
import type { TriggerEvent } from "../shared/types.js"
import type { postMeetingExtraction } from "../workflow/post-meeting.js"
import type { cardCallbackFlow } from "../workflow/card-callback.js"
import type { sourceIngestion } from "../workflow/source-ingestion.js"
import type { preMeetingBrief } from "../workflow/pre-meeting.js"

const IDEMPOTENCY_TTL = 3600
type EventHandler = (event: TriggerEvent) => Promise<{ dispatched: boolean; runId?: string }>

const eventHandlers: Record<string, EventHandler> = {
  "vc.meeting.meeting_ended_v1": handleMeetingEnd,
  meeting_end: handleMeetingEnd,
  "vc.meeting.meeting_started_v1": handleMeetingStart,
  meeting_start: handleMeetingStart,
  "card.action.trigger": handleCardCallback,
  card_callback: handleCardCallback,
  "im.message.receive_v1": handleSourceIngestionEvent,
  im_message: handleSourceIngestionEvent,
  doc_update: handleSourceIngestionEvent,
  wiki_update: handleSourceIngestionEvent,
  task_update: handleSourceIngestionEvent,
  mail_received: handleSourceIngestionEvent,
}

export async function dispatchToWorkflow(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const isDuplicate = await checkIdempotency(event.idempotencyKey)
  if (isDuplicate) {
    log.info("duplicate event, skipping", { eventId: event.eventId, key: event.idempotencyKey })
    return { dispatched: false }
  }

  await markProcessed(event.idempotencyKey)

  const handler = eventHandlers[event.eventType]
  if (!handler) {
    log.info("unhandled event type, ignoring", { eventType: event.eventType })
    return { dispatched: false }
  }
  return handler(event)
}

async function handleMeetingEnd(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload as Record<string, unknown>
  const meeting = payload.meeting as Record<string, unknown> | undefined
  const meetingId = (meeting?.id as string) ?? (payload.meeting_id as string) ?? ""
  const chatId = (meeting?.meeting_chat_id as string) ?? (payload.chat_id as string) ?? ""

  if (!meetingId) {
    log.warn("meeting_end event without meeting_id", { eventId: event.eventId })
    return { dispatched: false }
  }

  log.info("dispatching post-meeting extraction", { meetingId, chatId })

  const handle = await tasks.trigger<typeof postMeetingExtraction>("post-meeting-extraction", {
    meetingId,
    chatId: chatId || undefined,
  })

  log.info("workflow dispatched", { runId: handle.id, meetingId })
  return { dispatched: true, runId: handle.id }
}

async function handleMeetingStart(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload as Record<string, unknown>
  const meeting = payload.meeting as Record<string, unknown> | undefined
  const meetingId = (meeting?.id as string) ?? (payload.meeting_id as string) ?? ""
  const meetingTitle = (meeting?.title as string) ?? (payload.title as string) ?? "未命名会议"
  const chatId = (meeting?.meeting_chat_id as string) ?? (payload.chat_id as string) ?? ""
  const topicText = (meeting?.description as string) ?? (payload.description as string) ?? ""

  if (!meetingId) {
    log.warn("meeting_start event without meeting_id", { eventId: event.eventId })
    return { dispatched: false }
  }

  const handle = await tasks.trigger<typeof preMeetingBrief>("pre-meeting-brief", {
    meetingId,
    meetingTitle,
    topicText: topicText || undefined,
    chatId: chatId || undefined,
  })

  log.info("pre-meeting brief workflow dispatched", { runId: handle.id, meetingId, chatId })
  return { dispatched: true, runId: handle.id }
}

async function handleCardCallback(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload.event && typeof event.payload.event === "object"
    ? event.payload
    : { event: event.payload }
  const handle = await tasks.trigger<typeof cardCallbackFlow>("card-callback", payload)
  log.info("card callback workflow dispatched", { runId: handle.id, eventId: event.eventId })
  return { dispatched: true, runId: handle.id }
}

async function handleSourceIngestionEvent(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload
  const originChannel = inferOriginChannel(event.eventType, payload)
  const originContextId = extractString(payload, [
    "originContextId",
    "source_id",
    "message_id",
    "doc_token",
    "wiki_token",
    "task_id",
    "mail_id",
    "id",
  ])
  const contentText = extractString(payload, ["contentText", "content_text", "text", "content", "summary", "subject"])

  if (!originChannel || !originContextId || !contentText) {
    log.warn("source ingestion event missing required content, skipping", {
      eventId: event.eventId,
      eventType: event.eventType,
      hasOriginContextId: Boolean(originContextId),
      hasContentText: Boolean(contentText),
    })
    return { dispatched: false }
  }

  const handle = await tasks.trigger<typeof sourceIngestion>("source-ingestion", {
    originChannel,
    originContextId,
    title: extractString(payload, ["title", "name", "subject"]) || undefined,
    contentText,
    ownerUserId: extractString(payload, ["ownerUserId", "owner_user_id", "sender_id"]) || undefined,
    sourceUrl: extractString(payload, ["sourceUrl", "source_url", "url"]) || undefined,
    projectToBase: true,
  })

  log.info("source ingestion workflow dispatched", {
    runId: handle.id,
    originChannel,
    originContextId,
  })
  return { dispatched: true, runId: handle.id }
}

async function checkIdempotency(key: string): Promise<boolean> {
  const exists = await redis.exists(`idemp:${key}`)
  return exists === 1
}

async function markProcessed(key: string): Promise<void> {
  await redis.setex(`idemp:${key}`, IDEMPOTENCY_TTL, "1")
}

function inferOriginChannel(eventType: string, payload: Record<string, unknown>) {
  const explicit = payload.originChannel ?? payload.origin_channel
  if (isKnownOriginChannel(explicit)) return explicit
  if (eventType.includes("im") || eventType.includes("message")) return "im"
  if (eventType.includes("wiki")) return "wiki"
  if (eventType.includes("doc")) return "doc"
  if (eventType.includes("task")) return "task"
  if (eventType.includes("mail")) return "mail"
  return null
}

function isKnownOriginChannel(value: unknown): value is "meeting" | "minutes" | "doc" | "wiki" | "im" | "task" | "mail" {
  return typeof value === "string"
    && ["meeting", "minutes", "doc", "wiki", "im", "task", "mail"].includes(value)
}

function extractString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  const nestedEvent = payload.event
  if (nestedEvent && typeof nestedEvent === "object") {
    return extractString(nestedEvent as Record<string, unknown>, keys)
  }
  const message = payload.message
  if (message && typeof message === "object") {
    return extractString(message as Record<string, unknown>, keys)
  }
  return ""
}
