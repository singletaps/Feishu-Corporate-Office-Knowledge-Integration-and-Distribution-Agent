import { renderPostMeetingCard, renderRiskAlertCard, renderPreMeetingCard } from "./render.js"
import { sendCardToChat, sendCardToUser } from "../integration/message.js"
import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import type { WorkItem, KnowledgeArtifact } from "../shared/types.js"

export async function sendPostMeetingConfirmCard(
  items: WorkItem[],
  meetingTitle: string,
  chatId: string,
): Promise<string> {
  log.info("sending post-meeting confirm card", { itemCount: items.length, chatId })
  const cardJson = renderPostMeetingCard(items, meetingTitle)
  const messageId = await sendCardToChat(chatId, cardJson)

  for (const item of items) {
    await db.execute(
      `INSERT INTO push_records
         (artifact_id, channel_type, target_type, target_id, delivery_status, sent_at)
       VALUES (NULL, 'card', 'group', $1, 'sent', now())`,
      [chatId],
    )
  }

  log.info("post-meeting card sent", { messageId, itemCount: items.length })
  return messageId
}

export async function sendRiskAlertCards(
  items: WorkItem[],
  owners: Array<{ openId: string; items: WorkItem[] }>,
): Promise<string[]> {
  log.info("sending risk alert cards", { ownerCount: owners.length })
  const messageIds: string[] = []

  for (const owner of owners) {
    const cardJson = renderRiskAlertCard(owner.items)
    const messageId = await sendCardToUser(owner.openId, cardJson)
    messageIds.push(messageId)
  }

  log.info("risk alert cards sent", { count: messageIds.length })
  return messageIds
}

export async function sendPreMeetingCard(
  brief: KnowledgeArtifact,
  chatId: string,
): Promise<string> {
  log.info("sending pre-meeting card", { chatId })
  const cardJson = renderPreMeetingCard(brief)
  return sendCardToChat(chatId, cardJson)
}
