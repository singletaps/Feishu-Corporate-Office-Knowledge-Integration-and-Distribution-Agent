import { larkCli, larkCliStdin } from "./lark-cli.js"
import { log } from "../evaluation/logger.js"

export async function sendCardToChat(chatId: string, cardJson: Record<string, unknown>): Promise<string> {
  log.info("sending card to chat", { chatId })
  const data = await sendInteractiveMessage("chat_id", chatId, cardJson)

  const messageId = data.messageId
  log.info("card sent", { chatId, messageId })
  return messageId
}

export async function sendCardToUser(openId: string, cardJson: Record<string, unknown>): Promise<string> {
  log.info("sending card to user", { openId })
  const data = await sendInteractiveMessage("open_id", openId, cardJson)

  const messageId = data.messageId
  log.info("card sent to user", { openId, messageId })
  return messageId
}

export async function sendTextToChat(chatId: string, text: string): Promise<string> {
  log.info("sending text to chat", { chatId, textLength: text.length })
  const data = (await larkCliStdin([
    "api",
    "POST",
    "/open-apis/im/v1/messages",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ receive_id_type: "chat_id" }),
    "--data",
    "-",
  ], JSON.stringify({
    receive_id: chatId,
    msg_type: "text",
    content: JSON.stringify({ text }),
  }))) as { data?: { message_id?: string }; message_id?: string } | null

  return data?.data?.message_id ?? data?.message_id ?? ""
}

export async function updateCard(messageId: string, cardJson: Record<string, unknown>): Promise<void> {
  log.info("updating card", { messageId })
  await larkCli([
    "im", "messages", "patch",
    "--as", "bot",
    "--message_id", messageId,
    "--data", JSON.stringify({ content: JSON.stringify(cardJson) }),
  ])
}

async function sendInteractiveMessage(
  receiveIdType: "chat_id" | "open_id",
  receiveId: string,
  cardJson: Record<string, unknown>,
): Promise<{ messageId: string }> {
  const response = await larkCliStdin([
    "api",
    "POST",
    "/open-apis/im/v1/messages",
    "--as",
    "bot",
    "--params",
    JSON.stringify({ receive_id_type: receiveIdType }),
    "--data",
    "-",
  ], JSON.stringify({
    receive_id: receiveId,
    msg_type: "interactive",
    content: JSON.stringify(cardJson),
  })) as {
    data?: { message_id?: string }
    message_id?: string
  } | null

  return { messageId: response?.data?.message_id ?? response?.message_id ?? "" }
}
