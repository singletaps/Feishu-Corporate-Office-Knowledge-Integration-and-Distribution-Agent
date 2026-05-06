import { larkCli } from "./lark-cli.js"
import { log } from "../evaluation/logger.js"
import type { CreateTaskParams, FeishuTaskDetail, FeishuTaskResult } from "../shared/types.js"

export async function createFeishuTask(params: CreateTaskParams): Promise<FeishuTaskResult> {
  log.info("creating feishu task", { title: params.title, owner: params.ownerOpenId })

  const args = ["task", "+create", "--summary", params.title]

  if (params.description) {
    args.push("--description", params.description)
  }

  if (params.ownerOpenId) {
    args.push("--assignee", params.ownerOpenId)
  }

  if (params.dueAt) {
    args.push("--due", params.dueAt.toISOString())
  }

  if (params.sourceLink) {
    args.push("--origin-href", params.sourceLink)
  }

  const data = (await larkCli(args)) as {
    task_id?: string
    guid?: string
    url?: string
    task?: { guid?: string; url?: string }
    data?: { guid?: string; url?: string; task?: { guid?: string; url?: string } }
  } | null

  const taskId = data?.task_id ?? data?.guid ?? data?.task?.guid ?? data?.data?.task?.guid ?? data?.data?.guid ?? ""
  const url = data?.url ?? data?.task?.url ?? data?.data?.task?.url ?? data?.data?.url ?? ""
  log.info("feishu task created", { taskId, url })

  return { taskId, url }
}

export async function getFeishuTaskStatus(taskId: string): Promise<string> {
  log.info("getting feishu task status", { taskId })
  const detail = await getFeishuTaskDetail(taskId)
  return detail.status ?? "unknown"
}

export async function getFeishuTaskStatuses(taskIds: string[]): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  for (const id of taskIds) {
    const status = await getFeishuTaskStatus(id)
    statuses.set(id, status)
  }
  return statuses
}

export async function getFeishuTaskDetail(taskId: string): Promise<FeishuTaskDetail> {
  log.info("getting feishu task detail", { taskId })
  const mock = getMockTaskDetail(taskId)
  if (mock) return mock

  const data = await larkCli(["task", "tasks", "get", "--task_id", taskId])
  return normalizeFeishuTaskDetail(taskId, data)
}

export function normalizeFeishuTaskDetail(taskId: string, data: unknown): FeishuTaskDetail {
  const root = getObject(data)
  const nestedData = getObject(root?.data)
  const task = getObject(root?.task)
    ?? getObject(nestedData?.task)
    ?? getObject(nestedData)
    ?? root
    ?? {}

  const id = getString(task, "task_id")
    || getString(task, "guid")
    || getString(task, "id")
    || getString(root, "task_id")
    || getString(root, "guid")
    || taskId

  return {
    taskId: id,
    status: getString(task, "status") || getString(task, "task_status") || null,
    title: getString(task, "summary") || getString(task, "title") || getString(task, "name") || null,
    url: getString(task, "url") || getString(root, "url") || null,
    raw: root ?? undefined,
  }
}

function getMockTaskDetail(taskId: string): FeishuTaskDetail | null {
  const raw = process.env.FEISHU_TASK_MOCK_JSON
  if (!raw?.trim()) return null

  try {
    const parsed = JSON.parse(raw) as unknown
    const details = Array.isArray(parsed) ? parsed : [parsed]
    for (const detail of details) {
      const normalized = normalizeFeishuTaskDetail(taskId, detail)
      if (normalized.taskId === taskId) return normalized
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.warn("invalid FEISHU_TASK_MOCK_JSON ignored", { error: err.message })
  }

  return null
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function getString(value: unknown, key: string): string {
  const obj = getObject(value)
  const raw = obj?.[key]
  return typeof raw === "string" && raw.trim() ? raw.trim() : ""
}
