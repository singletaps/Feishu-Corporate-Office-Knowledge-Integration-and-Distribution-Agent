import { db } from "../shared/db.js"
import { AppError } from "../shared/errors.js"
import { projectWorkItemsToBase } from "../integration/base.js"
import { larkCli } from "../integration/lark-cli.js"
import { renderWorkItemDraftCard, renderWorkItemListCard } from "../touchpoint/render.js"
import {
  assertHubPermission,
  inviteHubMember,
  removeHubMember,
  writeHubAudit,
} from "./hub-service.js"
import type { WorkItem } from "../shared/types.js"

export type HubCommandInput =
  | { command: "add_item"; title: string }
  | { command: "list_items" }
  | { command: "all_items" }
  | { command: "update_item"; workItemId: string; title: string }
  | { command: "delete_item"; workItemId: string }
  | { command: "invite_member"; userOpenId: string; role?: "owner_admin" | "admin" | "editor" | "contributor" | "viewer" | "member" }
  | { command: "remove_member"; userOpenId: string }

export type HubCommandResult =
  | { kind: "text"; text: string }
  | { kind: "card"; card: Record<string, unknown> }

export async function executeHubCommand(input: {
  hubId: string
  actorOpenId?: string
  command: HubCommandInput
}): Promise<HubCommandResult> {
  switch (input.command.command) {
    case "add_item":
      return addItem(input.hubId, input.actorOpenId, input.command.title)
    case "list_items":
      return listItems(input.hubId, input.actorOpenId)
    case "all_items":
      return exportAllItems(input.hubId, input.actorOpenId)
    case "update_item":
      return updateItem(input.hubId, input.actorOpenId, input.command.workItemId, input.command.title)
    case "delete_item":
      return deleteItem(input.hubId, input.actorOpenId, input.command.workItemId)
    case "invite_member":
      return inviteMember(input.hubId, input.actorOpenId, input.command.userOpenId, input.command.role)
    case "remove_member":
      return removeMember(input.hubId, input.actorOpenId, input.command.userOpenId)
  }
}

async function addItem(hubId: string, actorOpenId: string | undefined, title: string): Promise<HubCommandResult> {
  await assertHubPermission(actorOpenId, hubId, "item:write")
  return { kind: "card", card: renderWorkItemDraftCard({ title, hubId, actorOpenId }) }
}

async function listItems(hubId: string, actorOpenId: string | undefined): Promise<HubCommandResult> {
  await assertHubPermission(actorOpenId, hubId, "item:read")
  const items = await db.query<WorkItem>(
    `SELECT wi.*
     FROM work_items wi
     JOIN work_item_hub_projections p ON p.work_item_id = wi.id
     WHERE p.hub_id = $1
       AND p.sync_status <> 'removed'
       AND wi.deleted_at IS NULL
       AND wi.status NOT IN ('done', 'closed')
     ORDER BY COALESCE(wi.due_at, wi.created_at) ASC
     LIMIT 20`,
    [hubId],
  )
  return { kind: "card", card: renderWorkItemListCard({ items, hubId, title: "当前 Hub WorkItem" }) }
}

async function exportAllItems(hubId: string, actorOpenId: string | undefined): Promise<HubCommandResult> {
  await assertHubPermission(actorOpenId, hubId, "item:read")
  const items = await db.query<WorkItem>(
    `SELECT wi.*
     FROM work_items wi
     JOIN work_item_hub_projections p ON p.work_item_id = wi.id
     WHERE p.hub_id = $1
       AND p.sync_status <> 'removed'
       AND wi.deleted_at IS NULL
     ORDER BY COALESCE(wi.due_at, wi.created_at) ASC`,
    [hubId],
  )
  const sheet = await createAllItemsSheet(items, hubId)
  await writeHubAudit({
    hubId,
    actorOpenId,
    action: "command_export_all_items",
    targetType: "sheet",
    targetId: sheet.url ?? sheet.spreadsheetToken,
    payload: { itemCount: items.length, spreadsheetToken: sheet.spreadsheetToken },
  })
  return {
    kind: "text",
    text: [
      `已生成全部 WorkItem 电子表格，共 ${items.length} 条。`,
      sheet.url ? `链接：${sheet.url}` : `Spreadsheet Token：${sheet.spreadsheetToken}`,
      sheet.permissionGrant ? `授权状态：${sheet.permissionGrant.status ?? "unknown"}` : "",
    ].filter(Boolean).join("\n"),
  }
}

async function updateItem(
  hubId: string,
  actorOpenId: string | undefined,
  workItemId: string,
  title: string,
): Promise<HubCommandResult> {
  await assertHubPermission(actorOpenId, hubId, "item:write")
  await requireProjection(hubId, workItemId)
  const rows = await db.query<WorkItem>(
    `UPDATE work_items
     SET title = $2, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [workItemId, title],
  )
  if (!rows[0]) throw new AppError("WorkItem not found", "ITEM_NOT_FOUND", { workItemId, hubId })
  await projectWorkItemsToBase(rows, { hubId })
  await writeHubAudit({ hubId, actorOpenId, action: "command_update_item", targetType: "work_item", targetId: workItemId, payload: { title } })
  return { kind: "text", text: `已更新待办：${rows[0].title}\nWorkItem ID：${rows[0].id}` }
}

async function deleteItem(hubId: string, actorOpenId: string | undefined, workItemId: string): Promise<HubCommandResult> {
  await assertHubPermission(actorOpenId, hubId, "item:write")
  await requireProjection(hubId, workItemId)
  await db.execute(
    `UPDATE work_items SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [workItemId],
  )
  await db.execute(
    `UPDATE work_item_hub_projections
     SET sync_status = 'removed', updated_at = now()
     WHERE work_item_id = $1 AND hub_id = $2`,
    [workItemId, hubId],
  )
  await writeHubAudit({ hubId, actorOpenId, action: "command_delete_item", targetType: "work_item", targetId: workItemId })
  return { kind: "text", text: `已删除待办：${workItemId}` }
}

async function inviteMember(
  hubId: string,
  actorOpenId: string | undefined,
  userOpenId: string,
  role?: "owner_admin" | "admin" | "editor" | "contributor" | "viewer" | "member",
): Promise<HubCommandResult> {
  if (!actorOpenId) throw new AppError("Missing actor identity", "HUB_PERMISSION_DENIED", { hubId })
  const member = await inviteHubMember({ hubId, actorOpenId, userOpenId, role })
  return { kind: "text", text: `已邀请成员：${member.userOpenId}\n角色：${member.role}` }
}

async function removeMember(hubId: string, actorOpenId: string | undefined, userOpenId: string): Promise<HubCommandResult> {
  if (!actorOpenId) throw new AppError("Missing actor identity", "HUB_PERMISSION_DENIED", { hubId })
  const result = await removeHubMember({ hubId, actorOpenId, userOpenId })
  return {
    kind: "text",
    text: result.removed
      ? `已移除成员：${userOpenId}\n剩余人类成员数：${result.remainingHumanMembers}`
      : `成员不存在：${userOpenId}`,
  }
}

async function requireProjection(hubId: string, workItemId: string): Promise<void> {
  const row = await db.queryOne<{ id: string }>(
    `SELECT id FROM work_item_hub_projections
     WHERE hub_id = $1 AND work_item_id = $2 AND sync_status <> 'removed'`,
    [hubId, workItemId],
  )
  if (!row) throw new AppError("WorkItem is not projected to this Hub", "ITEM_NOT_IN_HUB", { hubId, workItemId })
}

async function createAllItemsSheet(items: WorkItem[], hubId: string): Promise<{
  spreadsheetToken: string
  url: string | null
  permissionGrant?: { status?: string }
}> {
  const headers = [
    "WorkItem ID",
    "标题",
    "类型",
    "状态",
    "优先级",
    "负责人",
    "截止时间",
    "来源类型",
    "来源 ID",
    "Hub ID",
    "创建时间",
    "更新时间",
  ]
  const data = items.map((item) => [
    item.id,
    item.title,
    item.itemType,
    item.status,
    item.priority ?? "",
    item.ownerUserId ?? "",
    item.dueAt ? formatDateTime(item.dueAt) : "",
    item.originChannel,
    item.originContextId,
    hubId,
    formatDateTime(item.createdAt),
    formatDateTime(item.updatedAt),
  ])
  const title = `FeishuAgent WorkItems ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`
  const response = await createSheetWithFallback([
    "sheets", "+create",
    "--title", title,
    "--headers", JSON.stringify(headers),
    "--data", JSON.stringify(data),
  ]) as {
    spreadsheetToken?: string
    spreadsheet_token?: string
    url?: string
    data?: {
      spreadsheetToken?: string
      spreadsheet_token?: string
      url?: string
      permission_grant?: { status?: string }
      permissionGrant?: { status?: string }
    }
    permission_grant?: { status?: string }
    permissionGrant?: { status?: string }
  } | null

  const payload = response?.data ?? response
  return {
    spreadsheetToken: payload?.spreadsheetToken ?? payload?.spreadsheet_token ?? "",
    url: payload?.url ?? null,
    permissionGrant: payload?.permissionGrant ?? payload?.permission_grant,
  }
}

async function createSheetWithFallback(args: string[]): Promise<unknown> {
  const withIdentity = (identity: "bot" | "user") => [
    args[0],
    args[1],
    "--as",
    identity,
    ...args.slice(2),
  ].filter((value): value is string => Boolean(value))

  try {
    return await larkCli(withIdentity("bot"))
  } catch (error) {
    if (!isMissingSheetCreateScope(error)) throw error
  }

  try {
    return await larkCli(withIdentity("user"))
  } catch (error) {
    if (!isMissingSheetCreateScope(error)) throw error
    throw new AppError(
      "无法创建 WorkItem 电子表格：应用或当前用户缺少 sheets:spreadsheet:create 权限。请在飞书开放平台开通 scope 后重试。",
      "SHEETS_CREATE_SCOPE_MISSING",
      {
        scope: "sheets:spreadsheet:create",
        consoleUrl: `https://open.feishu.cn/page/scope-apply?clientID=${process.env.FEISHU_APP_ID ?? ""}&scopes=sheets%3Aspreadsheet%3Acreate`,
      },
    )
  }
}

function isMissingSheetCreateScope(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  const detail = typeof error.context?.detail === "string" ? error.context.detail : error.message
  return detail.includes("sheets:spreadsheet:create") || detail.includes("99991672")
}

function formatDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
