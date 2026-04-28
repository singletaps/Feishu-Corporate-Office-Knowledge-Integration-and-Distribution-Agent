import { db } from "../shared/db.js"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import { getMeetingDetail, getMinutesByMeetingId } from "../integration/meeting.js"
import { createFeishuTask, getFeishuTaskStatuses } from "../integration/task.js"
import { projectWorkItemsToBase } from "../integration/base.js"
import { sendPostMeetingConfirmCard, sendRiskAlertCards } from "../touchpoint/card.js"
import { recordPushRecord } from "../evaluation/push-records.js"
import {
  extractWorkItems,
  reconcileAndSave,
  listActiveItems,
  syncExternalTaskStatuses,
  findOverdueAndBlocked,
} from "../domain/work-item.js"
import { applyHubAssignment, collectSourceContextForAssignment } from "./hub-assignment-service.js"
import type { WorkItem } from "../shared/types.js"

export interface ExtractMeetingItemsOptions {
  meetingId: string
  chatId?: string
  sendCard?: boolean
  createTasks?: boolean
  projectToBase?: boolean
  changedById?: string
}

export interface ExtractMeetingItemsResult {
  meetingId: string
  meetingTitle: string
  extractedCount: number
  savedCount: number
  tasksCreated: string[]
  cardMessageId: string | null
  baseUrl: string
  items: WorkItem[]
}

export interface SyncWorkItemHubResult {
  activeCount: number
  taskBindingCount: number
  changedCount: number
  projectedCount: number
  baseUrl: string
}

export interface InspectRisksResult {
  overdueCount: number
  blockedCount: number
  projectedCount: number
  alertedOwnerCount: number
  baseUrl: string
  items: WorkItem[]
}

export async function extractMeetingItemsFlow(
  options: ExtractMeetingItemsOptions,
): Promise<ExtractMeetingItemsResult> {
  const sendCard = options.sendCard ?? Boolean(options.chatId)
  const createTasks = options.createTasks ?? true
  const projectToBase = options.projectToBase ?? true
  const { meetingId, chatId } = options

  log.info("extract meeting items flow started", { meetingId, sendCard, createTasks, projectToBase })

  const [detail, minutes] = await Promise.all([
    getMeetingDetail(meetingId),
    getMinutesByMeetingId(meetingId),
  ])

  if (!minutes.transcript) {
    log.warn("no transcript found, skipping extraction", { meetingId })
    return {
      meetingId,
      meetingTitle: detail.title,
      extractedCount: 0,
      savedCount: 0,
      tasksCreated: [],
      cardMessageId: null,
      baseUrl: config.feishu.baseUrl,
      items: [],
    }
  }

  const participants = minutes.participants.length > 0 ? minutes.participants : detail.participants
  const extracted = await extractWorkItems(minutes.transcript, participants, "meeting", meetingId)
  const saved = await reconcileAndSave(extracted, "meeting", meetingId, participants, {
    changedById: options.changedById ?? "extract-meeting-items",
  })

  const tasksCreated = createTasks ? await createTasksForItems(saved, detail.title) : []

  for (const item of saved) {
    const evidence = await collectSourceContextForAssignment({
      originChannel: "meeting",
      originContextId: meetingId,
      title: detail.title,
      contentText: minutes.transcript,
      chatId,
      chatType: chatId ? "group" : "unknown",
      ownerUserId: item.ownerUserId ?? undefined,
      participantOpenIds: participants.map((participant) => participant.openId),
      explicitHubId: undefined,
      changedById: options.changedById ?? "extract-meeting-items",
    })
    const assignment = await applyHubAssignment({
      workItem: item,
      evidence,
      changedById: options.changedById ?? "extract-meeting-items",
    })

    if (projectToBase) {
      for (const hubId of assignment.appliedHubIds) {
        await projectWorkItemsToBase([item], { hubId })
      }
    }
  }

  const cardMessageId = chatId && sendCard && saved.length > 0
    ? await sendPostMeetingConfirmCard(saved, detail.title, chatId)
    : null

  if (chatId && cardMessageId) {
    await recordPushRecord({
      channelType: "card",
      targetType: "group",
      targetId: chatId,
      externalMessageId: cardMessageId,
      deliveryStatus: "sent",
    })
  }

  const result = {
    meetingId,
    meetingTitle: detail.title,
    extractedCount: extracted.length,
    savedCount: saved.length,
    tasksCreated,
    cardMessageId,
    baseUrl: config.feishu.baseUrl,
    items: saved,
  }

  log.info("extract meeting items flow complete", {
    meetingId,
    extractedCount: result.extractedCount,
    savedCount: result.savedCount,
    taskCount: tasksCreated.length,
    cardMessageId,
  })

  return result
}

export async function syncWorkItemHubFlow(limit = 200): Promise<SyncWorkItemHubResult> {
  const activeItems = await listActiveItems({ limit })
  const taskIds = await findBoundFeishuTaskIds(activeItems)
  const statuses = await getFeishuTaskStatuses(taskIds)
  const changed = await syncExternalTaskStatuses(statuses)
  const itemsToProject = changed.length > 0 ? changed : activeItems

  const projectedCount = await projectItemsToAssignedHubs(itemsToProject)

  return {
    activeCount: activeItems.length,
    taskBindingCount: taskIds.length,
    changedCount: changed.length,
    projectedCount,
    baseUrl: config.feishu.baseUrl,
  }
}

export async function inspectRisksFlow(sendAlerts = false): Promise<InspectRisksResult> {
  const { overdue, blocked } = await findOverdueAndBlocked()
  const riskyItems = dedupeItems([...overdue, ...blocked])

  const projectedCount = await projectItemsToAssignedHubs(riskyItems)

  const owners = groupByOwner(riskyItems)
  const messageIds = sendAlerts && owners.length > 0
    ? await sendRiskAlertCards(riskyItems, owners)
    : []

  for (let i = 0; i < messageIds.length; i++) {
    const owner = owners[i]
    if (!owner) continue
    await recordPushRecord({
      channelType: "card",
      targetType: "user",
      targetId: owner.openId,
      externalMessageId: messageIds[i],
      deliveryStatus: "sent",
    })
  }

  return {
    overdueCount: overdue.length,
    blockedCount: blocked.length,
    projectedCount,
    alertedOwnerCount: messageIds.length,
    baseUrl: config.feishu.baseUrl,
    items: riskyItems,
  }
}

async function createTasksForItems(items: WorkItem[], meetingTitle: string): Promise<string[]> {
  const tasksCreated: string[] = []
  const todos = items.filter((item) => item.itemType === "todo" && !item.needHumanConfirm && item.ownerUserId)

  for (const item of todos) {
    const result = await createFeishuTask({
      title: item.title,
      ownerOpenId: item.ownerUserId,
      dueAt: item.dueAt,
      description: `来源: 会议「${meetingTitle}」`,
      sourceLink: null,
    })

    if (!result.taskId) continue
    tasksCreated.push(result.taskId)

    await db.execute(
      `INSERT INTO task_bindings (work_item_id, binding_type, external_id, is_primary, binding_role, sync_status)
       VALUES ($1, 'feishu_task', $2, true, 'execution', 'synced')
       ON CONFLICT DO NOTHING`,
      [item.id, result.taskId],
    )
  }

  return tasksCreated
}

async function findBoundFeishuTaskIds(items: WorkItem[]): Promise<string[]> {
  if (items.length === 0) return []

  const bindings = await db.query<{ externalId: string }>(
    `SELECT external_id FROM task_bindings
     WHERE binding_type = 'feishu_task'
     AND work_item_id = ANY($1::uuid[])`,
    [items.map((item) => item.id)],
  )

  return bindings.map((binding) => binding.externalId).filter(Boolean)
}

function groupByOwner(items: WorkItem[]): Array<{ openId: string; items: WorkItem[] }> {
  const groups = new Map<string, WorkItem[]>()

  for (const item of items) {
    if (!item.ownerUserId) continue
    const existing = groups.get(item.ownerUserId) ?? []
    existing.push(item)
    groups.set(item.ownerUserId, existing)
  }

  return Array.from(groups.entries()).map(([openId, ownerItems]) => ({ openId, items: ownerItems }))
}

function dedupeItems(items: WorkItem[]): WorkItem[] {
  const byId = new Map<string, WorkItem>()
  for (const item of items) {
    byId.set(item.id, item)
  }
  return Array.from(byId.values())
}

async function projectItemsToAssignedHubs(items: WorkItem[]): Promise<number> {
  let projectedCount = 0
  for (const item of items) {
    const hubIds = await findAssignedHubIds(item.id)
    if (hubIds.length === 0) {
      await projectWorkItemsToBase([item])
      projectedCount += 1
      continue
    }
    for (const hubId of hubIds) {
      await projectWorkItemsToBase([item], { hubId })
      projectedCount += 1
    }
  }
  return projectedCount
}

async function findAssignedHubIds(workItemId: string): Promise<string[]> {
  const rows = await db.query<{ hubId: string }>(
    `SELECT hub_id
     FROM work_item_hub_projections
     WHERE work_item_id = $1
       AND sync_status <> 'removed'
     ORDER BY CASE projection_role WHEN 'primary' THEN 1 ELSE 2 END, created_at ASC`,
    [workItemId],
  )
  return rows.map((row) => row.hubId)
}
