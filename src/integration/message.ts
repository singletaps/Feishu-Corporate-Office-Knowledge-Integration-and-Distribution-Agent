import { larkCli } from "./lark-cli.js"
import { log } from "../evaluation/logger.js"

export async function sendCardToChat(chatId: string, cardJson: Record<string, unknown>): Promise<string> {
  log.info("sending card to chat", { chatId })
  const data = (await larkCli([
    "im", "+messages-send",
    "--chat-id", chatId,
    "--msg-type", "interactive",
    "--content", JSON.stringify(cardJson),
  ])) as { message_id?: string } | null

  const messageId = data?.message_id ?? ""
  log.info("card sent", { chatId, messageId })
  return messageId
}

export async function sendCardToUser(openId: string, cardJson: Record<string, unknown>): Promise<string> {
  log.info("sending card to user", { openId })
  const data = (await larkCli([
    "im", "+messages-send",
    "--user-id", openId,
    "--msg-type", "interactive",
    "--content", JSON.stringify(cardJson),
  ])) as { message_id?: string } | null

  const messageId = data?.message_id ?? ""
  log.info("card sent to user", { openId, messageId })
  return messageId
}

export async function sendTextToChat(chatId: string, text: string): Promise<string> {
  log.info("sending text to chat", { chatId, textLength: text.length })
  const data = (await larkCli([
    "im", "+messages-send",
    "--chat-id", chatId,
    "--msg-type", "text",
    "--content", JSON.stringify({ text }),
  ])) as { message_id?: string } | null

  return data?.message_id ?? ""
}

export async function updateCard(messageId: string, cardJson: Record<string, unknown>): Promise<void> {
  log.info("updating card", { messageId })
  await larkCli([
    "im", "messages", "patch",
    "--message_id", messageId,
    "--data", JSON.stringify({ content: JSON.stringify(cardJson) }),
  ])
}
