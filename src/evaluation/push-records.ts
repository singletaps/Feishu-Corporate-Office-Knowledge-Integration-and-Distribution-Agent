import { db } from "../shared/db.js"

export async function recordPushRecord(input: {
  artifactId?: string | null
  channelType: "card" | "im" | "doc" | "base" | "cli"
  targetType: "user" | "group" | "department" | "cli_local"
  targetId: string
  externalMessageId?: string | null
  renderedPayload?: Record<string, unknown> | null
  deliveryStatus?: "pending" | "sent" | "failed" | "acknowledged"
}): Promise<void> {
  await db.execute(
    `INSERT INTO push_records
       (artifact_id, channel_type, target_type, target_id, external_message_id,
        rendered_payload, delivery_status, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 = 'sent' THEN now() ELSE NULL END)`,
    [
      input.artifactId ?? null,
      input.channelType,
      input.targetType,
      input.targetId,
      input.externalMessageId ?? null,
      input.renderedPayload ? JSON.stringify(input.renderedPayload) : null,
      input.deliveryStatus ?? "sent",
    ],
  )
}

export async function acknowledgePushRecordByMessage(messageId: string): Promise<void> {
  await recordPushInteractionByMessage(messageId, {})
}

export async function recordPushInteractionByMessage(
  messageId: string,
  input: {
    action?: string
    actorId?: string
    workItemId?: string | null
  },
): Promise<void> {
  await db.execute(
    `UPDATE push_records
     SET clicked = true,
         delivery_status = 'acknowledged',
         acknowledged_at = COALESCE(acknowledged_at, now()),
         rendered_payload = COALESCE(rendered_payload, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
                'lastCardAction', $2::text,
                'lastCardActorId', $3::text,
                'lastCardWorkItemId', $4::text,
                'lastCardInteractedAt', now()
              ))
     WHERE external_message_id = $1`,
    [messageId, input.action ?? null, input.actorId ?? null, input.workItemId ?? null],
  )
}
