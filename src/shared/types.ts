export const ItemType = {
  Todo: "todo",
  Decision: "decision",
  Risk: "risk",
  Blocker: "blocker",
} as const
export type ItemType = (typeof ItemType)[keyof typeof ItemType]

export const ItemStatus = {
  New: "new",
  PendingReview: "pending_review",
  Active: "active",
  Blocked: "blocked",
  Done: "done",
  Closed: "closed",
} as const
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus]

export const Priority = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical",
} as const
export type Priority = (typeof Priority)[keyof typeof Priority]

export const OriginChannel = {
  Meeting: "meeting",
  Minutes: "minutes",
  Doc: "doc",
  Wiki: "wiki",
  Im: "im",
  Task: "task",
  Mail: "mail",
} as const
export type OriginChannel = (typeof OriginChannel)[keyof typeof OriginChannel]

export const ArtifactType = {
  PreMeetingBrief: "pre_meeting_brief",
  MeetingSummary: "meeting_summary",
  RiskReport: "risk_report",
  WeeklyInsight: "weekly_insight",
  CliHint: "cli_hint",
  TaskDigest: "task_digest",
} as const
export type ArtifactType = (typeof ArtifactType)[keyof typeof ArtifactType]

export const DeliveryChannel = {
  Card: "card",
  Im: "im",
  Doc: "doc",
  Base: "base",
  Cli: "cli",
} as const
export type DeliveryChannel = (typeof DeliveryChannel)[keyof typeof DeliveryChannel]

// ----- Core business objects -----

export interface WorkItem {
  id: string
  title: string
  itemType: ItemType
  status: ItemStatus
  priority: Priority | null
  ownerUserId: string | null
  ownerSource: "manual" | "inferred" | "inherited" | null
  responsibleHubId: string | null
  hubAssignmentSource:
    | "explicit_binding"
    | "chat_context"
    | "doc_context"
    | "calendar_context"
    | "agent_decision"
    | "manual_confirm"
    | "inherited"
    | "personal_fallback"
    | "pending"
    | null
  dueAt: Date | null
  confidenceScore: number | null
  needHumanConfirm: boolean
  originChannel: OriginChannel
  originContextId: string
  currentReviewTaskId: string | null
  dedupeKey: string | null
  metadata: Record<string, unknown>
  firstDetectedAt: Date | null
  lastDetectedAt: Date | null
  lastSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface KnowledgeAsset {
  id: string
  assetType: string
  sourceId: string
  title: string | null
  contentText: string | null
  ownerUserId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface KnowledgeArtifact {
  id: string
  artifactType: ArtifactType
  title: string | null
  summary: string | null
  contentPayload: Record<string, unknown> | null
  canonicalRenderFormat: "card" | "doc" | "table" | "cli_text"
  status: "draft" | "ready" | "published" | "expired" | "archived"
  confidenceScore: number | null
  generatedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

// ----- Trigger event -----

export interface TriggerEvent {
  eventId: string
  eventType: string
  source: "feishu_event" | "cron" | "cli" | "card_callback"
  idempotencyKey: string
  payload: Record<string, unknown>
  occurredAt: Date
  receivedAt: Date
}

// ----- Integration types -----

export interface FeishuUser {
  openId: string
  name: string
  email?: string
}

export interface MeetingMinutes {
  meetingId: string
  title: string
  transcript: string
  actionItems: string[]
  participants: FeishuUser[]
  startTime: Date
  endTime: Date
}

export interface CalendarEventDetail {
  eventId: string
  summary: string
  description: string
  startTime: Date
  endTime: Date
  attendees: FeishuUser[]
  meetingChatId: string | null
}

export interface CreateTaskParams {
  title: string
  ownerOpenId: string | null
  dueAt: Date | null
  description: string | null
  sourceLink: string | null
}

export interface FeishuTaskResult {
  taskId: string
  url: string
}

export interface FeishuTaskDetail {
  taskId: string
  status: string | null
  title?: string | null
  url?: string | null
  raw?: Record<string, unknown>
}

// ----- Domain types -----

export interface ExtractedWorkItem {
  title: string
  itemType: ItemType
  ownerName: string | null
  dueAt: string | null
  priority: Priority | null
  confidenceScore: number
  metadata: Record<string, unknown>
}

export interface ChangedBy {
  type: "workflow" | "human" | "sync"
  id: string
}
