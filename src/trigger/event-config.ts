import { OriginChannel } from "../shared/types.js"

const DEFAULT_SUBSCRIBED_EVENT_TYPES = [
  "im.message.receive_v1",
  "card.action.trigger",
]

const DEFAULT_SOURCE_EVENT_TYPES = [
  "doc_update",
  "wiki_update",
  "task_update",
  "mail_received",
]

const DEFAULT_SOURCE_EVENT_ALIASES: Record<string, string[]> = {
  [OriginChannel.Doc]: ["doc_update"],
  [OriginChannel.Wiki]: ["wiki_update"],
  [OriginChannel.Task]: ["task_update"],
  [OriginChannel.Mail]: ["mail_received"],
}

const SOURCE_EVENT_ENV: Record<string, string> = {
  [OriginChannel.Doc]: "FEISHU_DOC_EVENT_TYPES",
  [OriginChannel.Wiki]: "FEISHU_WIKI_EVENT_TYPES",
  [OriginChannel.Task]: "FEISHU_TASK_EVENT_TYPES",
  [OriginChannel.Mail]: "FEISHU_MAIL_EVENT_TYPES",
}

export function getSubscribedEventTypes(): string[] {
  const base = parseEventList(process.env.FEISHU_EVENT_TYPES)
  const extra = parseEventList(process.env.FEISHU_EXTRA_EVENT_TYPES)
  return unique([...(base.length ? base : DEFAULT_SUBSCRIBED_EVENT_TYPES), ...extra])
}

export function getSourceEventTypes(): string[] {
  return unique([
    ...DEFAULT_SOURCE_EVENT_TYPES,
    ...parseEventList(process.env.FEISHU_SOURCE_EVENT_TYPES),
    ...Object.values(SOURCE_EVENT_ENV).flatMap((name) => parseEventList(process.env[name])),
  ])
}

export function classifySourceEventType(
  eventType: string,
): typeof OriginChannel.Doc | typeof OriginChannel.Wiki | typeof OriginChannel.Task | typeof OriginChannel.Mail | null {
  const normalized = eventType.trim().toLowerCase()
  if (!normalized) return null

  for (const channel of [OriginChannel.Doc, OriginChannel.Wiki, OriginChannel.Task, OriginChannel.Mail] as const) {
    const aliases = [
      ...DEFAULT_SOURCE_EVENT_ALIASES[channel],
      ...parseEventList(process.env[SOURCE_EVENT_ENV[channel]]),
    ].map((value) => value.toLowerCase())
    if (aliases.includes(normalized)) return channel
  }

  if (/\bwiki\b|wiki_/u.test(normalized)) return OriginChannel.Wiki
  if (/\bdoc\b|doc_|document/u.test(normalized)) return OriginChannel.Doc
  if (/\btask\b|task_/u.test(normalized)) return OriginChannel.Task
  if (/\bmail\b|mail_|email/u.test(normalized)) return OriginChannel.Mail
  return null
}

export function isConfiguredSourceEventType(eventType: string): boolean {
  const normalized = eventType.trim().toLowerCase()
  return getSourceEventTypes().map((value) => value.toLowerCase()).includes(normalized)
}

function parseEventList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[\s,;]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
