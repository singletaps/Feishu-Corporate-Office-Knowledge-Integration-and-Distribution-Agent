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

export const queryWorkItemsSchema = z.object({
  ownerUserId: z.string().optional(),
  status: z.array(z.enum(["new", "pending_review", "active", "blocked", "done", "closed"])).optional(),
  itemType: z.enum(["todo", "decision", "risk", "blocker"]).optional(),
  originChannel: z.enum(["meeting", "minutes", "doc", "wiki", "im", "task", "mail"]).optional(),
  limit: z.number().int().positive().max(200).default(50),
})

export const summarizeWorkItemHubSchema = z.object({
  limit: z.number().int().positive().max(200).default(200),
})

export type ExtractMeetingItemsInput = z.infer<typeof extractMeetingItemsSchema>
export type SyncWorkItemHubInput = z.infer<typeof syncWorkItemHubSchema>
export type InspectRisksInput = z.infer<typeof inspectRisksSchema>
export type QueryWorkItemsInput = z.infer<typeof queryWorkItemsSchema>
export type SummarizeWorkItemHubInput = z.infer<typeof summarizeWorkItemHubSchema>
