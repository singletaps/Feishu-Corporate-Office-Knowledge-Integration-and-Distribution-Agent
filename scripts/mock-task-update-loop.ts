import type { TriggerEvent } from "../src/shared/types.js"
import type { FeishuTaskSyncResult } from "../src/domain/work-item.js"

const mockWorkItemId = "00000000-0000-0000-0000-000000000001"

async function main(): Promise<void> {
  setMockEnvironment()
  const { mapFeishuTaskStatus } = await import("../src/domain/task-status.js")
  const { reconcileFeishuTaskUpdateFlow } = await import("../src/application/task-reconciliation-service.js")
  const { mapFeishuEventToInboundRoute } = await import("../src/trigger/feishu-ingestion-adapter.js")

  const eventRoute = mapFeishuEventToInboundRoute(makeTaskUpdateEvent({
    task_id: "task_from_payload",
    task: { status: "completed", summary: "payload status loop" },
  }))

  if (eventRoute.kind !== "task_reconciliation") {
    throw new Error(`expected task_reconciliation route, got ${eventRoute.kind}`)
  }

  const fromPayload = await reconcileFeishuTaskUpdateFlow({
    taskId: eventRoute.taskId,
    taskDetail: eventRoute.taskDetail,
    eventId: "mock-event-payload",
  }, {
    syncTaskStatus: async (taskId, externalStatus) => mockSyncTaskStatus(mapFeishuTaskStatus, taskId, externalStatus),
  })

  const fromMockPull = await reconcileFeishuTaskUpdateFlow({
    taskId: "task_from_mock_pull",
    eventId: "mock-event-pull",
  }, {
    fetchTaskDetail: async (taskId) => ({
      taskId,
      status: "in_progress",
      title: "mock lark-cli pull loop",
      raw: { task: { guid: taskId, status: "in_progress" } },
    }),
    syncTaskStatus: async (taskId, externalStatus) => mockSyncTaskStatus(mapFeishuTaskStatus, taskId, externalStatus),
  })

  console.log(JSON.stringify({
    payloadRoute: eventRoute.kind,
    fromPayload: {
      taskId: fromPayload.taskId,
      externalStatus: fromPayload.externalStatus,
      mappedStatus: fromPayload.mappedStatus,
      action: fromPayload.sync?.action,
      workItemId: fromPayload.sync?.workItemId,
      source: fromPayload.source,
    },
    fromMockPull: {
      taskId: fromMockPull.taskId,
      externalStatus: fromMockPull.externalStatus,
      mappedStatus: fromMockPull.mappedStatus,
      action: fromMockPull.sync?.action,
      workItemId: fromMockPull.sync?.workItemId,
      source: fromMockPull.source,
    },
  }, null, 2))
}

function setMockEnvironment(): void {
  process.env.DATABASE_URL ??= "postgres://mock:mock@localhost:5432/mock"
  process.env.REDIS_URL ??= "redis://localhost:6379"
  process.env.FEISHU_APP_ID ??= "mock_app"
  process.env.FEISHU_BASE_TOKEN ??= "mock_base"
  process.env.FEISHU_BASE_TABLE_ID ??= "mock_table"
  process.env.FEISHU_BASE_URL ??= "https://mock.feishu.cn"
}

function makeTaskUpdateEvent(payload: Record<string, unknown>): TriggerEvent {
  return {
    eventId: "mock-event",
    eventType: "task_update",
    source: "feishu_event",
    idempotencyKey: "mock::task_update",
    payload,
    occurredAt: new Date(),
    receivedAt: new Date(),
  }
}

async function mockSyncTaskStatus(
  mapFeishuTaskStatus: (externalStatus: string, current: "active") => "active" | "done" | "closed" | null,
  taskId: string,
  externalStatus: string,
): Promise<FeishuTaskSyncResult> {
  const mappedStatus = mapFeishuTaskStatus(externalStatus, "active")
  if (!mappedStatus) {
    return {
      action: "ignored",
      taskId,
      workItemId: mockWorkItemId,
      externalStatus,
      currentStatus: "active",
      reason: "unmapped_status",
    }
  }

  return {
    action: mappedStatus === "active" ? "unchanged" : "updated",
    taskId,
    workItemId: mockWorkItemId,
    externalStatus,
    currentStatus: "active",
    mappedStatus,
    reason: "mock_local_loop",
  }
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error))
  console.error(err.message)
  process.exitCode = 1
})
