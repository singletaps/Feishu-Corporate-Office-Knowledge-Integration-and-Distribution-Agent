import { larkCli } from "./lark-cli.js"

export interface FetchMailInput {
  mailId?: string
  threadId?: string
  userMailboxId?: string
}

export interface MailMessageDetail {
  mailId?: string
  threadId?: string
  subject?: string
  from?: string
  receivedAt?: string
  bodyText: string
  sourceUrl?: string
}

export async function fetchMailContent(input: FetchMailInput): Promise<MailMessageDetail> {
  if (input.threadId) {
    const response = await larkCli([
      "mail",
      "+thread",
      "--as",
      "user",
      "--thread-id",
      input.threadId,
      "--html=false",
      ...(input.userMailboxId ? ["--mailbox", input.userMailboxId] : []),
    ])
    return normalizeLarkMailResponse(response, input)
  }

  if (!input.mailId) {
    throw new Error("mail fetch requires mailId or threadId")
  }

  const response = await larkCli([
    "mail",
    "+message",
    "--as",
    "user",
    "--message-id",
    input.mailId,
    "--html=false",
    ...(input.userMailboxId ? ["--mailbox", input.userMailboxId] : []),
  ])
  return normalizeLarkMailResponse(response, input)
}

export function normalizeLarkMailResponse(response: unknown, fallback: FetchMailInput): MailMessageDetail {
  const root = getObject(response) ?? {}
  const data = getObject(root.data) ?? root
  const messages = collectMessages(data)

  if (messages.length > 0) {
    const first = messages[0]
    const last = messages[messages.length - 1]
    return {
      mailId: firstString(first, ["mailId", "mail_id", "messageId", "message_id"]) || fallback.mailId,
      threadId: firstString(first, ["threadId", "thread_id"]) || fallback.threadId,
      subject: firstString(first, ["subject", "title"]) || firstString(last, ["subject", "title"]),
      from: formatAddress(first.from ?? first.sender ?? first.sender_address ?? first.from_address),
      receivedAt: firstString(first, ["receivedAt", "received_at", "date", "sentAt", "sent_at", "createTime", "create_time"]),
      bodyText: messages.map(formatMessageBody).filter(Boolean).join("\n\n---\n\n"),
      sourceUrl: firstString(first, ["sourceUrl", "source_url", "url", "link"]),
    }
  }

  return {
    mailId: firstString(data, ["mailId", "mail_id", "messageId", "message_id"]) || fallback.mailId,
    threadId: firstString(data, ["threadId", "thread_id"]) || fallback.threadId,
    subject: firstString(data, ["subject", "title"]),
    from: formatAddress(data.from ?? data.sender ?? data.sender_address ?? data.from_address),
    receivedAt: firstString(data, ["receivedAt", "received_at", "date", "sentAt", "sent_at", "createTime", "create_time"]),
    bodyText: firstString(data, ["bodyText", "body_text", "plainText", "plain_text", "text", "body", "content", "summary"]),
    sourceUrl: firstString(data, ["sourceUrl", "source_url", "url", "link"]),
  }
}

function collectMessages(data: Record<string, unknown>): Record<string, unknown>[] {
  const direct = getArray(data.messages) ?? getArray(data.items) ?? getArray(data.message_list)
  if (direct) return direct.map((item) => getObject(item)).filter((item): item is Record<string, unknown> => Boolean(item))

  const thread = getObject(data.thread)
  const nested = thread ? getArray(thread.messages) ?? getArray(thread.items) : null
  if (nested) return nested.map((item) => getObject(item)).filter((item): item is Record<string, unknown> => Boolean(item))

  const message = getObject(data.message)
  return message ? [message] : []
}

function formatMessageBody(message: Record<string, unknown>): string {
  const from = formatAddress(message.from ?? message.sender ?? message.sender_address ?? message.from_address)
  const receivedAt = firstString(message, ["receivedAt", "received_at", "date", "sentAt", "sent_at", "createTime", "create_time"])
  const body = firstString(message, ["bodyText", "body_text", "plainText", "plain_text", "text", "body", "content", "summary"])
  return [
    from ? `发件人: ${from}` : "",
    receivedAt ? `时间: ${receivedAt}` : "",
    body,
  ].filter(Boolean).join("\n")
}

function formatAddress(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(formatAddress).filter(Boolean).join(", ")
  const obj = getObject(value)
  if (!obj) return ""

  const name = firstString(obj, ["name", "displayName", "display_name"])
  const email = firstString(obj, ["email", "address", "mail_address", "mailAddress"])
  if (name && email) return `${name} <${email}>`
  return name || email
}

function firstString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === "string" && value.trim()) return stripHtml(value)
    if (typeof value === "number") return String(value)
  }
  return ""
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim()
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}
