import { log } from "../evaluation/logger.js"
import { getFeishuTaskDetail } from "../integration/task.js"
import { mapFeishuTaskStatus } from "../domain/task-status.js"
import type { FeishuTaskSyncResult } from "../domain/work-item.js"
import type { FeishuTaskDetail, ItemStatus } from "../shared/types.js"

export interface ReconcileFeishuTaskUpdateInput {
  taskId: string
  taskDetail?: FeishuTaskDetail
  eventId?: string
  actorOpenId?: string
}

export interface TaskReconciliationDependencies {
  fetchTaskDetail?: (taskId: string) => Promise<FeishuTaskDetail>
  syncTaskStatus?: (taskId: string, externalStatus: string) => Promise<FeishuTaskSyncResult>
}

export interface FeishuTaskUpdateReconciliationResult {
  taskId: string
  externalStatus: string | null
  mappedStatus: ItemStatus | null
  sync: FeishuTaskSyncResult | null
  source: "event_payload" | "pull"
}

export async function reconcileFeishuTaskUpdateFlow(
  input: ReconcileFeishuTaskUpdateInput,
  dependencies: TaskReconciliationDependencies = {},
): Promise<FeishuTaskUpdateReconciliationResult> {
  const fetchTaskDetail = dependencies.fetchTaskDetail ?? getFeishuTaskDetail
  const syncTaskStatus = dependencies.syncTaskStatus ?? (await import("../domain/work-item.js")).syncExternalTaskStatus
  const taskDetail = input.taskDetail?.status ? input.taskDetail : await fetchTaskDetail(input.taskId)
  const source = input.taskDetail?.status ? "event_payload" : "pull"
  const externalStatus = taskDetail.status

  if (!externalStatus) {
    log.warn("feishu task update ignored because task detail has no status", {
      taskId: input.taskId,
      eventId: input.eventId,
    })
    return {
      taskId: input.taskId,
      externalStatus: null,
      mappedStatus: null,
      sync: null,
      source,
    }
  }

  const mappedStatus = mapFeishuTaskStatus(externalStatus, "active")
  const sync = await syncTaskStatus(input.taskId, externalStatus)

  log.info("feishu task update reconciled", {
    taskId: input.taskId,
    externalStatus,
    mappedStatus,
    action: sync.action,
    workItemId: sync.workItemId,
    source,
  })

  return {
    taskId: input.taskId,
    externalStatus,
    mappedStatus,
    sync,
    source,
  }
}
