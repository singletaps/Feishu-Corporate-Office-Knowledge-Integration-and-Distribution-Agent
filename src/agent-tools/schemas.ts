import { z } from "zod"

export const extractMeetingItemsSchema = z.object({
  meetingId: z.string().min(1),
  chatId: z.string().optional(),
  sendCard: z.boolean().default(false),
  createTasks: z.boolean().default(true),
})

export const syncWorkItemHubSchema = z.object({
  limit: z.number().int().positive().max(200).default(200),
})

export const inspectRisksSchema = z.object({
  sendAlerts: z.boolean().default(false),
})

export const ingestSourceItemsSchema = z.object({
  originChannel: z.enum(["meeting", "minutes", "doc", "wiki", "im", "task", "mail"]),
  originContextId: z.string().min(1),
  title: z.string().optional(),
  contentText: z.string().min(1),
  ownerUserId: z.string().optional(),
  sourceUrl: z.string().optional(),
  chatId: z.string().optional(),
  chatType: z.enum(["group", "p2p", "unknown"]).optional(),
  actorOpenId: z.string().optional(),
  mentionedUserIds: z.array(z.string()).default([]),
  docToken: z.string().optional(),
  wikiSpaceId: z.string().optional(),
  folderToken: z.string().optional(),
  calendarEventId: z.string().optional(),
  participants: z.array(z.object({
    openId: z.string(),
    name: z.string(),
    email: z.string().optional(),
  })).default([]),
  projectToBase: z.boolean().default(true),
  hubId: z.string().uuid().optional(),
})

export const sourceContextInputSchema = z.object({
  originChannel: z.enum(["meeting", "minutes", "doc", "wiki", "im", "task", "mail"]),
  originContextId: z.string().min(1),
  title: z.string().optional(),
  contentText: z.string().optional(),
  sourceUrl: z.string().optional(),
  chatId: z.string().optional(),
  chatType: z.enum(["group", "p2p", "unknown"]).optional(),
  actorOpenId: z.string().optional(),
  ownerUserId: z.string().optional(),
  participantOpenIds: z.array(z.string()).default([]),
  mentionedUserIds: z.array(z.string()).default([]),
  docToken: z.string().optional(),
  wikiSpaceId: z.string().optional(),
  folderToken: z.string().optional(),
  calendarEventId: z.string().optional(),
  explicitHubId: z.string().uuid().optional(),
  eventType: z.string().optional(),
})

export const decideWorkItemHubSchema = z.object({
  evidence: z.record(z.string(), z.unknown()),
  workItemId: z.string().uuid().optional(),
})

export const applyHubAssignmentSchema = z.object({
  workItemId: z.string().uuid(),
  evidence: z.record(z.string(), z.unknown()),
  decision: z.record(z.string(), z.unknown()).optional(),
  changedById: z.string().optional(),
})

export const explainHubAssignmentSchema = z.object({
  workItemId: z.string().uuid(),
})

export const queryWorkItemsSchema = z.object({
  ownerUserId: z.string().optional(),
  status: z.array(z.enum(["new", "pending_review", "active", "blocked", "done", "closed"])).optional(),
  itemType: z.enum(["todo", "decision", "risk", "blocker"]).optional(),
  originChannel: z.enum(["meeting", "minutes", "doc", "wiki", "im", "task", "mail"]).optional(),
  limit: z.number().int().positive().max(200).default(50),
})

export const getWorkItemEvidenceSchema = z.object({
  workItemId: z.string().min(1),
})

export const summarizeWorkItemHubSchema = z.object({
  limit: z.number().int().positive().max(200).default(200),
})

export const generatePreMeetingBriefSchema = z.object({
  meetingId: z.string().min(1),
  meetingTitle: z.string().min(1),
  topicText: z.string().optional(),
  chatId: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
})

export const generateTaskDigestSchema = z.object({
  limit: z.number().int().positive().max(200).default(100),
})

export const visualizeEventHubSchema = z.object({
  includeMermaid: z.boolean().default(true),
})

export const publishEventHubViewSchema = z.object({})

export const completeEventHubTaskSchema = z.object({
  eventKey: z.string().min(1),
  completed: z.boolean().default(true),
})

export const hubRoleSchema = z.enum(["owner_admin", "admin", "editor", "contributor", "viewer", "member", "bot"])

export const listHubsSchema = z.object({
  actorOpenId: z.string().min(1).optional(),
})

export const resolveHubSchema = z.object({
  chatId: z.string().min(1).optional(),
  actorOpenId: z.string().min(1).optional(),
})

export const selectHubSchema = z.object({
  chatId: z.string().min(1),
  actorOpenId: z.string().min(1),
  hubId: z.string().uuid(),
})

export const hubMemberMutationSchema = z.object({
  hubId: z.string().uuid(),
  actorOpenId: z.string().min(1),
  userOpenId: z.string().min(1),
  role: hubRoleSchema.optional(),
})

export const hubTransferAdminSchema = z.object({
  hubId: z.string().uuid(),
  actorOpenId: z.string().min(1),
  nextOwnerOpenId: z.string().min(1),
})

export type ExtractMeetingItemsInput = z.infer<typeof extractMeetingItemsSchema>
export type SyncWorkItemHubInput = z.infer<typeof syncWorkItemHubSchema>
export type InspectRisksInput = z.infer<typeof inspectRisksSchema>
export type IngestSourceItemsInput = z.infer<typeof ingestSourceItemsSchema>
export type SourceContextInputTool = z.infer<typeof sourceContextInputSchema>
export type DecideWorkItemHubInput = z.infer<typeof decideWorkItemHubSchema>
export type ApplyHubAssignmentInput = z.infer<typeof applyHubAssignmentSchema>
export type ExplainHubAssignmentInput = z.infer<typeof explainHubAssignmentSchema>
export type QueryWorkItemsInput = z.infer<typeof queryWorkItemsSchema>
export type GetWorkItemEvidenceInput = z.infer<typeof getWorkItemEvidenceSchema>
export type SummarizeWorkItemHubInput = z.infer<typeof summarizeWorkItemHubSchema>
export type GeneratePreMeetingBriefInput = z.infer<typeof generatePreMeetingBriefSchema>
export type GenerateTaskDigestInput = z.infer<typeof generateTaskDigestSchema>
export type VisualizeEventHubInput = z.infer<typeof visualizeEventHubSchema>
export type PublishEventHubViewInput = z.infer<typeof publishEventHubViewSchema>
export type CompleteEventHubTaskInput = z.infer<typeof completeEventHubTaskSchema>
export type ListHubsInput = z.infer<typeof listHubsSchema>
export type ResolveHubInput = z.infer<typeof resolveHubSchema>
export type SelectHubInput = z.infer<typeof selectHubSchema>
export type HubMemberMutationInput = z.infer<typeof hubMemberMutationSchema>
export type HubTransferAdminInput = z.infer<typeof hubTransferAdminSchema>
