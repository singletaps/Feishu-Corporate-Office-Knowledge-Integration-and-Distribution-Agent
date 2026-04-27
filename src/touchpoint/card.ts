import { renderPostMeetingCard, renderRiskAlertCard, renderPreMeetingCard, renderWeeklyInsightCard } from "./render.js"
import { sendCardToChat, sendCardToUser } from "../integration/message.js"
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

export async function sendWeeklyInsightCard(insight: KnowledgeArtifact, chatId: string): Promise<string> {
  log.info("sending weekly insight card", { chatId, artifactId: insight.id })
  const cardJson = renderWeeklyInsightCard(insight)
  return sendCardToChat(chatId, cardJson)
}
