import { larkCli } from "./lark-cli.js"
import { log } from "../evaluation/logger.js"
import type { CreateTaskParams, FeishuTaskResult } from "../shared/types.js"

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
  const data = (await larkCli(["task", "tasks", "get", "--task_id", taskId])) as {
    task?: { status?: string }
  } | null

  return data?.task?.status ?? "unknown"
}

export async function getFeishuTaskStatuses(taskIds: string[]): Promise<Map<string, string>> {
  const statuses = new Map<string, string>()
  for (const id of taskIds) {
    const status = await getFeishuTaskStatus(id)
    statuses.set(id, status)
  }
  return statuses
}
