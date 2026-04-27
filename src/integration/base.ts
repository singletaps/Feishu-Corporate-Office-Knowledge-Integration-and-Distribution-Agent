import { randomUUID } from "node:crypto"
import { writeFileSync, unlinkSync } from "node:fs"
import { config } from "../shared/config.js"
import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import { larkCli } from "./lark-cli.js"
import type { WorkItem } from "../shared/types.js"

export interface BaseRecordResult {
  recordId: string
  url: string | null
}

export async function upsertWorkItemRecord(item: WorkItem): Promise<BaseRecordResult> {
  const bindingRecordId = await findBitableRecordId(item.id)
  const baseRecordId = bindingRecordId ?? await findRecordIdByWorkItemId(item.id)
  const existingRecordId = baseRecordId
  const linkedTaskId = await findFeishuTaskId(item.id)
  const fields = toBaseFields(item, linkedTaskId)

  log.info("upserting work item to base", {
    workItemId: item.id,
    existingRecordId,
    title: item.title,
  })

  const jsonFile = writeBaseJsonFile(fields)
  const args = [
    "base", "+record-upsert",
    "--as", "user",
    "--base-token", config.feishu.baseToken,
    "--table-id", config.feishu.baseTableId,
    "--json", jsonFile,
  ]

  if (existingRecordId) {
    args.push("--record-id", existingRecordId)
  }

  const response = await larkCli(args) as {
    data?: {
      record?: { record_id?: string; id?: string; url?: string }
      created?: boolean
      updated?: boolean
    }
  }

  const record = response.data?.record
  unlinkSync(jsonFile.slice(1))
  const recordId = record?.record_id
    ?? record?.id
    ?? existingRecordId
    ?? await findRecordIdByWorkItemId(item.id)
    ?? ""

  if (recordId && !bindingRecordId) {
    await db.execute(
      `INSERT INTO task_bindings
         (work_item_id, binding_type, external_id, is_primary, binding_role, sync_status, last_sync_at)
       VALUES ($1, 'bitable_record', $2, false, 'projection', 'synced', now())
       ON CONFLICT DO NOTHING`,
      [item.id, recordId],
    )
  }

  if (recordId && bindingRecordId) {
    await db.execute(
      `UPDATE task_bindings
       SET sync_status = 'synced', last_sync_at = now(), last_sync_error = NULL, updated_at = now()
       WHERE work_item_id = $1 AND binding_type = 'bitable_record' AND external_id = $2`,
      [item.id, recordId],
    )
  }

  log.info("base record upserted", { workItemId: item.id, recordId })
  return { recordId, url: record?.url ?? null }
}

async function findRecordIdByWorkItemId(workItemId: string): Promise<string | null> {
  const response = await larkCli([
    "base", "+record-list",
    "--as", "user",
    "--base-token", config.feishu.baseToken,
    "--table-id", config.feishu.baseTableId,
    "--limit", "200",
  ]) as {
    data?: {
      data?: unknown[][]
      fields?: string[]
      record_id_list?: string[]
    }
  }

  const rows = response.data?.data ?? []
  const fields = response.data?.fields ?? []
  const ids = response.data?.record_id_list ?? []
  const workItemIdIndex = fields.indexOf("WorkItem ID")

  if (workItemIdIndex < 0) return null

  for (let i = 0; i < rows.length; i++) {
    if (rows[i]?.[workItemIdIndex] === workItemId) {
      return ids[i] ?? null
    }
  }

  return null
}

export async function projectWorkItemsToBase(items: WorkItem[]): Promise<BaseRecordResult[]> {
  log.info("projecting work items to base", { count: items.length })
  const results: BaseRecordResult[] = []

  for (const item of items) {
    const result = await upsertWorkItemRecord(item)
    results.push(result)
  }

  log.info("base projection complete", { count: results.length })
  return results
}

async function findBitableRecordId(workItemId: string): Promise<string | null> {
  const binding = await db.queryOne<{ externalId: string }>(
    `SELECT external_id FROM task_bindings
     WHERE work_item_id = $1 AND binding_type = 'bitable_record'
     ORDER BY created_at DESC LIMIT 1`,
    [workItemId],
  )
  return binding?.externalId ?? null
}

async function findFeishuTaskId(workItemId: string): Promise<string | null> {
  const binding = await db.queryOne<{ externalId: string }>(
    `SELECT external_id FROM task_bindings
     WHERE work_item_id = $1 AND binding_type = 'feishu_task'
     ORDER BY created_at DESC LIMIT 1`,
    [workItemId],
  )
  return binding?.externalId ?? null
}

function toBaseFields(item: WorkItem, linkedTaskId: string | null): Record<string, unknown> {
  return {
    "事项标题": item.title,
    "事项类型": item.itemType,
    "状态": item.status,
    "优先级": item.priority,
    "负责人": null,
    "负责人ID": item.ownerUserId,
    "截止时间": item.dueAt ? formatDateTime(item.dueAt) : null,
    "置信度": item.confidenceScore,
    "来源类型": item.originChannel,
    "来源ID": item.originContextId,
    "飞书任务ID": linkedTaskId,
    "WorkItem ID": item.id,
  }
}

function formatDateTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function writeBaseJsonFile(fields: Record<string, unknown>): string {
  const filename = `./base-record-${randomUUID()}.json`
  writeFileSync(filename, JSON.stringify(fields), "utf-8")
  return `@${filename}`
}

