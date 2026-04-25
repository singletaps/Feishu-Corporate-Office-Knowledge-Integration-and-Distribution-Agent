import { tasks } from "@trigger.dev/sdk"
import { redis } from "../shared/redis.js"
import { log } from "../evaluation/logger.js"
import type { TriggerEvent } from "../shared/types.js"
import type { postMeetingExtraction } from "../workflow/post-meeting.js"

const IDEMPOTENCY_TTL = 3600

export async function dispatchToWorkflow(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const isDuplicate = await checkIdempotency(event.idempotencyKey)
  if (isDuplicate) {
    log.info("duplicate event, skipping", { eventId: event.eventId, key: event.idempotencyKey })
    return { dispatched: false }
  }

  await markProcessed(event.idempotencyKey)

  switch (event.eventType) {
    case "vc.meeting.meeting_ended_v1":
    case "meeting_end": {
      return handleMeetingEnd(event)
    }
    default: {
      log.info("unhandled event type, ignoring", { eventType: event.eventType })
      return { dispatched: false }
    }
  }
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

async function checkIdempotency(key: string): Promise<boolean> {
  const exists = await redis.exists(`idemp:${key}`)
  return exists === 1
}

async function markProcessed(key: string): Promise<void> {
  await redis.setex(`idemp:${key}`, IDEMPOTENCY_TTL, "1")
}
