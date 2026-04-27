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
  participants: z.array(z.object({
    openId: z.string(),
    name: z.string(),
    email: z.string().optional(),
  })).default([]),
  projectToBase: z.boolean().default(true),
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

export type ExtractMeetingItemsInput = z.infer<typeof extractMeetingItemsSchema>
export type SyncWorkItemHubInput = z.infer<typeof syncWorkItemHubSchema>
export type InspectRisksInput = z.infer<typeof inspectRisksSchema>
export type IngestSourceItemsInput = z.infer<typeof ingestSourceItemsSchema>
export type QueryWorkItemsInput = z.infer<typeof queryWorkItemsSchema>
export type GetWorkItemEvidenceInput = z.infer<typeof getWorkItemEvidenceSchema>
export type SummarizeWorkItemHubInput = z.infer<typeof summarizeWorkItemHubSchema>
export type GeneratePreMeetingBriefInput = z.infer<typeof generatePreMeetingBriefSchema>
export type GenerateTaskDigestInput = z.infer<typeof generateTaskDigestSchema>
export type VisualizeEventHubInput = z.infer<typeof visualizeEventHubSchema>
