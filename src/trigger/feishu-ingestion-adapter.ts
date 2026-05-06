import { OriginChannel, type FeishuTaskDetail, type TriggerEvent } from "../shared/types.js"
import type { HubCommandInput } from "../application/hub-command-service.js"
import { classifySourceEventType } from "./event-config.js"

export interface SourceIngestionPayload {
  originChannel: typeof OriginChannel[keyof typeof OriginChannel]
  originContextId: string
  title?: string
  contentText: string
  ownerUserId?: string
  sourceUrl?: string
  chatId?: string
  chatType?: "group" | "p2p" | "unknown"
  actorOpenId?: string
  mentionedUserIds?: string[]
  docToken?: string
  wikiSpaceId?: string
  folderToken?: string
  calendarEventId?: string
  projectToBase?: boolean
}

export type FeishuInboundRoute =
  | {
    kind: "source_ingestion"
    payload: SourceIngestionPayload
    chatId?: string
    actorOpenId?: string
  }
  | {
    kind: "source_pull"
    eventType: string
    originChannel: typeof OriginChannel.Doc | typeof OriginChannel.Wiki
    originContextId: string
    title?: string
    ownerUserId?: string
    sourceUrl?: string
    chatId?: string
    actorOpenId?: string
    mentionedUserIds?: string[]
    docToken?: string
    wikiToken?: string
    wikiSpaceId?: string
    folderToken?: string
  }
  | {
    kind: "help"
    chatId: string
    actorOpenId?: string
  }
  | {
    kind: "agent_question"
    chatId: string
    actorOpenId?: string
    question: string
    messageId: string
  }
  | {
    kind: "hub_command"
    chatId: string
    actorOpenId?: string
    command: "current_hub" | "select_hub" | "execute"
    hubId?: string
    hubCommand?: HubCommandInput
  }
  | {
    kind: "ignore"
    reason: string
    eventType: string
  }
  | {
    kind: "pending_pull"
    reason: string
    eventType: string
    originChannel: typeof OriginChannel[keyof typeof OriginChannel]
    originContextId?: string
  }
  | {
    kind: "mail_ingestion"
    eventType: string
    payload: Record<string, unknown>
    mailId?: string
    threadId?: string
    chatId?: string
    actorOpenId?: string
  }
  | {
    kind: "task_reconciliation"
    eventType: string
    taskId: string
    taskDetail?: FeishuTaskDetail
    actorOpenId?: string
  }

export function mapFeishuEventToInboundRoute(event: TriggerEvent): FeishuInboundRoute {
  if (event.eventType === "im.message.receive_v1" || event.eventType === "im_message") {
    return mapImMessageEvent(event)
  }

  const sourceEventChannel = classifySourceEventType(event.eventType)
  if (sourceEventChannel === OriginChannel.Doc) {
    return mapDocUpdateEvent(event)
  }
  if (sourceEventChannel === OriginChannel.Wiki) {
    return mapWikiUpdateEvent(event)
  }
  if (sourceEventChannel === OriginChannel.Task) {
    return mapTaskUpdateEvent(event)
  }
  if (sourceEventChannel === OriginChannel.Mail) {
    return mapMailReceivedEvent(event)
  }

  return mapGenericSourceEvent(event)
}

function mapMailReceivedEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const mailId = getFirstString(payload, ["mailId", "mail_id", "messageId", "message_id", "id"])
  const threadId = getFirstString(payload, ["threadId", "thread_id"])

  if (!mailId && !threadId) {
    return { kind: "ignore", reason: "mail event missing mail_id/thread_id", eventType: event.eventType }
  }

  return {
    kind: "mail_ingestion",
    eventType: event.eventType,
    payload,
    mailId: mailId || undefined,
    threadId: threadId || undefined,
    actorOpenId: getFirstString(payload, ["actorOpenId", "actor_open_id", "open_id", "user_id"]) || undefined,
  }
}

function mapImMessageEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const message = getObject(payload, "message") ?? payload
  const sender = getObject(payload, "sender")
  const senderId = getObject(sender, "sender_id")
  const messageId = getString(message, "message_id") || getString(payload, "message_id") || event.eventId
  const chatId = getString(message, "chat_id") || getString(payload, "chat_id")
  const actorOpenId = getString(senderId, "open_id")
    || getString(senderId, "user_id")
    || getString(payload, "sender_id")
    || getString(payload, "open_id")
  const messageType = getString(message, "message_type") || getString(message, "msg_type")
  const contentText = parseMessageContent(getString(message, "content") || getString(payload, "content"))
  const trimmed = contentText.trim()

  if (!chatId) {
    return { kind: "ignore", reason: "im message missing chat_id", eventType: event.eventType }
  }
  if (!messageId || !trimmed) {
    return { kind: "ignore", reason: "im message missing message_id or text content", eventType: event.eventType }
  }
  if (messageType && !["text", "post"].includes(messageType)) {
    return { kind: "ignore", reason: `unsupported im message_type: ${messageType}`, eventType: event.eventType }
  }

  const normalizedText = stripBotMention(trimmed)
  if (isHelpText(normalizedText)) {
    return { kind: "help", chatId, actorOpenId }
  }
  const hubCommand = parseHubCommand(normalizedText)
  if (hubCommand) {
    return { kind: "hub_command", chatId, actorOpenId, ...hubCommand }
  }
  if (isBotMentioned(payload) || startsWithAgentPrefix(normalizedText)) {
    return {
      kind: "agent_question",
      chatId,
      actorOpenId,
      question: stripAgentPrefix(normalizedText),
      messageId,
    }
  }
  if (!shouldIngestImText(normalizedText)) {
    return { kind: "ignore", reason: "im message did not match ingestion keywords", eventType: event.eventType }
  }

  return {
    kind: "source_ingestion",
    chatId,
    actorOpenId,
    payload: {
      originChannel: OriginChannel.Im,
      originContextId: messageId,
      title: `IM 消息 ${messageId}`,
      contentText: normalizedText,
      ownerUserId: actorOpenId || undefined,
      chatId,
      chatType: inferImChatType(chatId),
      actorOpenId,
      mentionedUserIds: extractMentionedUserIds(payload),
      projectToBase: true,
    },
  }
}

function mapDocUpdateEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const docToken = getFirstString(payload, [
    "docToken",
    "doc_token",
    "document_token",
    "document_id",
    "obj_token",
    "token",
  ])
  const originContextId = docToken || getFirstString(payload, ["originContextId", "source_id", "id"])

  if (!originContextId) {
    return pendingPull(event, OriginChannel.Doc, "doc update event missing doc token")
  }

  return {
    kind: "source_pull",
    eventType: event.eventType,
    originChannel: OriginChannel.Doc,
    originContextId,
    title: getFirstString(payload, ["title", "name"]) || undefined,
    ownerUserId: getFirstString(payload, ["ownerUserId", "owner_user_id", "owner_id", "operator_id", "user_id"]) || undefined,
    sourceUrl: getFirstString(payload, ["sourceUrl", "source_url", "url", "document_url"]) || undefined,
    chatId: getFirstString(payload, ["chatId", "chat_id"]) || undefined,
    actorOpenId: getFirstString(payload, ["actorOpenId", "actor_open_id", "operator_open_id", "open_id"]) || undefined,
    mentionedUserIds: extractMentionedUserIds(payload),
    docToken: docToken || originContextId,
    folderToken: getFirstString(payload, ["folderToken", "folder_token", "parent_token"]) || undefined,
  }
}

function mapWikiUpdateEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const wikiToken = getFirstString(payload, [
    "wikiToken",
    "wiki_token",
    "wiki_node_token",
    "node_token",
    "obj_token",
    "token",
  ])
  const docToken = getFirstString(payload, ["docToken", "doc_token", "document_token", "document_id"])
  const sourceUrl = getFirstString(payload, ["sourceUrl", "source_url", "url", "wiki_url", "document_url"])
  const originContextId = wikiToken || docToken || getFirstString(payload, ["originContextId", "source_id", "id"])

  if (!originContextId && !sourceUrl) {
    return pendingPull(event, OriginChannel.Wiki, "wiki update event missing wiki/doc token")
  }

  return {
    kind: "source_pull",
    eventType: event.eventType,
    originChannel: OriginChannel.Wiki,
    originContextId: originContextId || sourceUrl,
    title: getFirstString(payload, ["title", "name"]) || undefined,
    ownerUserId: getFirstString(payload, ["ownerUserId", "owner_user_id", "owner_id", "operator_id", "user_id"]) || undefined,
    sourceUrl: sourceUrl || undefined,
    chatId: getFirstString(payload, ["chatId", "chat_id"]) || undefined,
    actorOpenId: getFirstString(payload, ["actorOpenId", "actor_open_id", "operator_open_id", "open_id"]) || undefined,
    mentionedUserIds: extractMentionedUserIds(payload),
    docToken: docToken || undefined,
    wikiToken: wikiToken || undefined,
    wikiSpaceId: getFirstString(payload, ["wikiSpaceId", "wiki_space_id", "space_id"]) || undefined,
    folderToken: getFirstString(payload, ["folderToken", "folder_token", "parent_token"]) || undefined,
  }
}

function mapTaskUpdateEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const taskId = getFirstString(payload, ["task_id", "task_guid", "guid", "id"])
  if (!taskId) {
    return { kind: "ignore", reason: "task update missing task_id", eventType: event.eventType }
  }

  const task = getObject(payload, "task") ?? getObject(payload, "task_info") ?? payload
  const status = getFirstString(task, ["status", "task_status", "state"])
  const title = getFirstString(task, ["summary", "title", "name"])
  const url = getFirstString(task, ["url", "href", "origin_href"])

  return {
    kind: "task_reconciliation",
    eventType: event.eventType,
    taskId,
    taskDetail: status ? {
      taskId,
      status,
      title: title || null,
      url: url || null,
      raw: task,
    } : undefined,
    actorOpenId: getFirstString(payload, ["operator_id", "actor_open_id", "open_id"]) || undefined,
  }
}

function mapGenericSourceEvent(event: TriggerEvent): FeishuInboundRoute {
  const payload = event.payload
  const originChannel = inferOriginChannel(event.eventType, payload)
  const originContextId = getFirstString(payload, [
    "originContextId",
    "source_id",
    "message_id",
    "doc_token",
    "wiki_token",
    "task_id",
    "mail_id",
    "id",
  ])
  const contentText = getFirstString(payload, ["contentText", "content_text", "text", "content", "summary", "subject"])

  if (!originChannel || !originContextId || !contentText) {
    return {
      kind: "ignore",
      reason: "source event missing originChannel, originContextId, or contentText",
      eventType: event.eventType,
    }
  }

  return {
    kind: "source_ingestion",
    payload: {
      originChannel,
      originContextId,
      title: getFirstString(payload, ["title", "name", "subject"]) || undefined,
      contentText,
      ownerUserId: getFirstString(payload, ["ownerUserId", "owner_user_id", "sender_id"]) || undefined,
      sourceUrl: getFirstString(payload, ["sourceUrl", "source_url", "url"]) || undefined,
      chatId: getFirstString(payload, ["chatId", "chat_id"]) || undefined,
      chatType: inferImChatType(getFirstString(payload, ["chatId", "chat_id"])),
      actorOpenId: getFirstString(payload, ["actorOpenId", "actor_open_id", "sender_id", "open_id"]) || undefined,
      mentionedUserIds: extractMentionedUserIds(payload),
      docToken: getFirstString(payload, ["docToken", "doc_token"]) || undefined,
      wikiSpaceId: getFirstString(payload, ["wikiSpaceId", "wiki_space_id"]) || undefined,
      folderToken: getFirstString(payload, ["folderToken", "folder_token"]) || undefined,
      calendarEventId: getFirstString(payload, ["calendarEventId", "calendar_event_id"]) || undefined,
      projectToBase: true,
    },
  }
}

function pendingPull(
  event: TriggerEvent,
  originChannel: typeof OriginChannel[keyof typeof OriginChannel],
  reason: string,
): FeishuInboundRoute {
  return {
    kind: "pending_pull",
    reason,
    eventType: event.eventType,
    originChannel,
    originContextId: getFirstString(event.payload, ["doc_token", "document_token", "wiki_token", "task_id", "mail_id", "id"]) || undefined,
  }
}

function parseMessageContent(content: string): string {
  if (!content.trim()) return ""
  try {
    const parsed = JSON.parse(content) as unknown
    return collectText(parsed).join(" ").replace(/\s+/g, " ").trim()
  } catch {
    return content
  }
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(collectText)
  if (!value || typeof value !== "object") return []

  const obj = value as Record<string, unknown>
  const direct = ["text", "un_escape_text", "title", "content"]
    .flatMap((key) => collectText(obj[key]))
  const nested = ["elements", "children", "items"]
    .flatMap((key) => collectText(obj[key]))
  return [...direct, ...nested]
}

function stripBotMention(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/giu, " ")
    .replace(/^@\S+\s*/u, "")
    .replace(/\s+/g, " ")
    .trim()
}

function isHelpText(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  return normalized === "/help" || normalized === "help" || normalized === "帮助" || normalized === "？" || normalized === "?"
}

function startsWithAgentPrefix(text: string): boolean {
  return /^\/(ask|agent|问)\b/iu.test(text)
}

function stripAgentPrefix(text: string): string {
  return text.replace(/^\/(ask|agent|问)\b\s*/iu, "").trim()
}

function parseHubCommand(text: string): { command: "current_hub" | "select_hub" | "execute"; hubId?: string; hubCommand?: HubCommandInput } | null {
  const normalized = text.trim()
  if (normalized === "/hub" || normalized === "/current-hub" || normalized === "当前中枢") {
    return { command: "current_hub" }
  }
  if (normalized === "/list" || normalized === "查看待办" || normalized === "列出待办") {
    return { command: "execute", hubCommand: { command: "list_items" } }
  }
  if (normalized === "/all" || normalized === "全部待办" || normalized === "导出待办") {
    return { command: "execute", hubCommand: { command: "all_items" } }
  }

  const selected = normalized.match(/^\/select-hub\s+([0-9a-f-]{36})$/iu)
  if (selected?.[1]) {
    return { command: "select_hub", hubId: selected[1] }
  }

  const add = normalized.match(/^(?:\/add|新增待办|增加待办)\s+(.+)$/iu)
  if (add?.[1]) {
    return { command: "execute", hubCommand: { command: "add_item", title: add[1].trim() } }
  }

  const update = normalized.match(/^(?:\/update|修改待办)\s+([0-9a-f-]{36})\s+(.+)$/iu)
  if (update?.[1] && update[2]) {
    return { command: "execute", hubCommand: { command: "update_item", workItemId: update[1], title: update[2].trim() } }
  }

  const del = normalized.match(/^(?:\/delete|删除待办)\s+([0-9a-f-]{36})$/iu)
  if (del?.[1]) {
    return { command: "execute", hubCommand: { command: "delete_item", workItemId: del[1] } }
  }

  const invite = normalized.match(/^(?:\/invite|邀请成员)\s+(\S+)(?:\s+(owner_admin|admin|editor|contributor|viewer|member))?$/iu)
  if (invite?.[1]) {
    return {
      command: "execute",
      hubCommand: {
        command: "invite_member",
        userOpenId: invite[1],
        role: invite[2] as HubCommandInput extends { role?: infer R } ? R : never,
      },
    }
  }

  const remove = normalized.match(/^(?:\/remove-member|移除成员)\s+(\S+)$/iu)
  if (remove?.[1]) {
    return { command: "execute", hubCommand: { command: "remove_member", userOpenId: remove[1] } }
  }

  return null
}

function shouldIngestImText(text: string): boolean {
  return /(todo|待办|任务|跟进|阻塞|风险|决定|决议|deadline|ddl|负责人)/iu.test(text)
}

function isBotMentioned(payload: Record<string, unknown>): boolean {
  const mentions = getObject(payload, "mentions") ?? getObject(getObject(payload, "message"), "mentions")
  if (Array.isArray(mentions) && mentions.length > 0) return true
  const content = getString(getObject(payload, "message"), "content") || getString(payload, "content")
  return /<at[^>]*>/iu.test(content) || /^@\S+/u.test(parseMessageContent(content).trim())
}

function extractMentionedUserIds(payload: Record<string, unknown>): string[] {
  const mentions = getObject(payload, "mentions") ?? getObject(getObject(payload, "message"), "mentions")
  if (!Array.isArray(mentions)) return []

  return mentions
    .map((mention) => getObject(mention))
    .map((mention) => {
      const id = getObject(mention, "id") ?? getObject(mention, "user_id")
      return getString(id, "open_id")
        || getString(id, "user_id")
        || getString(mention, "open_id")
        || getString(mention, "user_id")
    })
    .filter((value): value is string => Boolean(value))
}

function inferImChatType(chatId?: string): "group" | "p2p" | "unknown" {
  if (!chatId) return "unknown"
  return chatId.startsWith("ou_") ? "p2p" : "group"
}

function inferOriginChannel(
  eventType: string,
  payload: Record<string, unknown>,
): typeof OriginChannel[keyof typeof OriginChannel] | null {
  const explicit = payload.originChannel ?? payload.origin_channel
  if (isKnownOriginChannel(explicit)) return explicit
  if (eventType.includes("im") || eventType.includes("message")) return OriginChannel.Im
  if (eventType.includes("wiki")) return OriginChannel.Wiki
  if (eventType.includes("doc")) return OriginChannel.Doc
  if (eventType.includes("task")) return OriginChannel.Task
  if (eventType.includes("mail")) return OriginChannel.Mail
  return null
}

function isKnownOriginChannel(value: unknown): value is typeof OriginChannel[keyof typeof OriginChannel] {
  return typeof value === "string" && Object.values(OriginChannel).includes(value as typeof OriginChannel[keyof typeof OriginChannel])
}

function getFirstString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = getString(payload, key)
    if (value) return value
  }
  const nestedEvent = getObject(payload, "event")
  if (nestedEvent) {
    const value = getFirstString(nestedEvent, keys)
    if (value) return value
  }
  for (const containerKey of ["message", "object", "document", "wiki", "node", "file", "operator", "sender"]) {
    const nested = getObject(payload, containerKey)
    if (!nested) continue
    const value = getFirstString(nested, keys)
    if (value) return value
  }
  return ""
}

function getObject(value: unknown, key?: string): Record<string, unknown> | null {
  const target = key && value && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : value
  return target && typeof target === "object" && !Array.isArray(target)
    ? target as Record<string, unknown>
    : null
}

function getString(value: unknown, key: string): string {
  const obj = getObject(value)
  const raw = obj?.[key]
  return typeof raw === "string" && raw.trim() ? raw.trim() : ""
}
