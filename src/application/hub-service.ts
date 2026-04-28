import { config } from "../shared/config.js"
import { db } from "../shared/db.js"
import { redis } from "../shared/redis.js"
import { AppError } from "../shared/errors.js"

const DEFAULT_HUB_NAME = "默认事项中枢"
const SESSION_TTL_SECONDS = 1800

export type HubType = "team" | "personal" | "org" | "legacy"
export type HubRole = "owner_admin" | "admin" | "editor" | "contributor" | "viewer" | "member" | "bot"
export type HubAction =
  | "hub:read"
  | "item:read"
  | "item:write"
  | "projection:sync"
  | "member:invite"
  | "member:remove"
  | "admin:transfer"

export interface ItemHub {
  id: string
  hubType: HubType
  name: string
  feishuBaseToken: string
  feishuTableId: string
  defaultChatId: string | null
  ownerUserId: string | null
  createdByOpenId: string | null
  hubStatus: "active" | "archived" | "dissolved"
  metadata: Record<string, unknown>
}

export interface HubMember {
  id: string
  hubId: string
  userOpenId: string
  role: HubRole
  capabilities: Record<string, unknown>
}

export interface HubTableRef {
  hubId: string
  baseToken: string
  tableId: string
}

export async function ensureDefaultHub(): Promise<ItemHub> {
  const existing = await db.queryOne<ItemHub>(
    `SELECT * FROM item_hubs
     WHERE hub_type = 'legacy' AND hub_status = 'active'
     ORDER BY created_at ASC LIMIT 1`,
  )
  if (existing) return existing

  const rows = await db.query<ItemHub>(
    `INSERT INTO item_hubs
       (hub_type, name, feishu_base_token, feishu_table_id, default_chat_id, metadata)
     VALUES ('legacy', $1, $2, $3, $4, $5)
     RETURNING *`,
    [
      DEFAULT_HUB_NAME,
      config.feishu.baseToken,
      config.feishu.baseTableId,
      config.notifications.defaultChatId,
      JSON.stringify({ source: "legacy_env" }),
    ],
  )
  return rows[0]
}

export async function resolveHubTable(hubId?: string): Promise<HubTableRef> {
  const hub = hubId
    ? await getActiveHub(hubId)
    : await ensureDefaultHub()
  return {
    hubId: hub.id,
    baseToken: hub.feishuBaseToken,
    tableId: hub.feishuTableId,
  }
}

export async function getActiveHub(hubId: string): Promise<ItemHub> {
  const hub = await db.queryOne<ItemHub>(
    `SELECT * FROM item_hubs WHERE id = $1 AND hub_status = 'active'`,
    [hubId],
  )
  if (!hub) throw new AppError("Hub not found or inactive", "HUB_NOT_FOUND", { hubId })
  return hub
}

export async function listHubsForUser(actorOpenId: string): Promise<ItemHub[]> {
  return db.query<ItemHub>(
    `SELECT ih.*
     FROM item_hubs ih
     JOIN hub_members hm ON hm.hub_id = ih.id
     WHERE ih.hub_status = 'active'
       AND hm.user_open_id = $1
     ORDER BY ih.created_at ASC`,
    [actorOpenId],
  )
}

export async function resolveHubForChat(chatId?: string, actorOpenId?: string): Promise<ItemHub> {
  if (chatId && actorOpenId) {
    const selectedHubId = await redis.get(sessionKey(chatId, actorOpenId))
    if (selectedHubId) return getActiveHub(selectedHubId)
  }

  if (chatId) {
    const hubs = await db.query<ItemHub>(
      `SELECT * FROM item_hubs
       WHERE default_chat_id = $1 AND hub_status = 'active'
       ORDER BY created_at ASC`,
      [chatId],
    )
    if (hubs.length === 1) return hubs[0]
    if (hubs.length > 1) {
      throw new AppError("Chat is bound to multiple Hubs; choose one before executing this command", "HUB_AMBIGUOUS", {
        chatId,
        candidates: hubs.map((hub) => ({ id: hub.id, name: hub.name, hubType: hub.hubType })),
      })
    }
  }

  return ensureDefaultHub()
}

export async function findBoundHubForChat(chatId: string): Promise<ItemHub | null> {
  const hubs = await db.query<ItemHub>(
    `SELECT * FROM item_hubs
     WHERE default_chat_id = $1 AND hub_status = 'active'
     ORDER BY created_at ASC`,
    [chatId],
  )
  if (hubs.length === 1) return hubs[0]
  if (hubs.length > 1) {
    throw new AppError("Chat is bound to multiple Hubs; choose one before executing this command", "HUB_AMBIGUOUS", {
      chatId,
      candidates: hubs.map((hub) => ({ id: hub.id, name: hub.name, hubType: hub.hubType })),
    })
  }
  return null
}

export async function bindHubSession(chatId: string, actorOpenId: string, hubId: string): Promise<void> {
  await getActiveHub(hubId)
  await redis.setex(sessionKey(chatId, actorOpenId), SESSION_TTL_SECONDS, hubId)
  await writeHubAudit({
    hubId,
    actorOpenId,
    action: "bind_chat_session",
    targetType: "hub",
    targetId: hubId,
    payload: { chatId, ttlSeconds: SESSION_TTL_SECONDS },
  })
}

export async function inviteHubMember(input: {
  hubId: string
  actorOpenId: string
  userOpenId: string
  role?: HubRole
}): Promise<HubMember> {
  await assertHubPermission(input.actorOpenId, input.hubId, "member:invite")
  const rows = await db.query<HubMember>(
    `INSERT INTO hub_members (hub_id, user_open_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (hub_id, user_open_id)
     DO UPDATE SET role = EXCLUDED.role, updated_at = now()
     RETURNING *`,
    [input.hubId, input.userOpenId, input.role ?? "member"],
  )
  await writeHubAudit({
    hubId: input.hubId,
    actorOpenId: input.actorOpenId,
    action: "member_invite",
    targetType: "member",
    targetId: input.userOpenId,
    payload: { role: input.role ?? "member" },
  })
  return rows[0]
}

export async function removeHubMember(input: {
  hubId: string
  actorOpenId: string
  userOpenId: string
}): Promise<{ removed: boolean; remainingHumanMembers: number }> {
  await assertHubPermission(input.actorOpenId, input.hubId, "member:remove")
  const member = await db.queryOne<HubMember>(
    `SELECT * FROM hub_members WHERE hub_id = $1 AND user_open_id = $2`,
    [input.hubId, input.userOpenId],
  )
  if (!member) return { removed: false, remainingHumanMembers: await countHumanMembers(input.hubId) }
  if (member.role === "owner_admin") {
    const ownerCount = await countOwnerAdmins(input.hubId)
    if (ownerCount <= 1) {
      throw new AppError("Cannot remove the last owner_admin; transfer admin first", "HUB_LAST_OWNER_ADMIN", {
        hubId: input.hubId,
        userOpenId: input.userOpenId,
      })
    }
  }

  await db.execute(
    `DELETE FROM hub_members WHERE hub_id = $1 AND user_open_id = $2`,
    [input.hubId, input.userOpenId],
  )
  const transferredOwner = await transferOwnedItemsAfterMemberRemoval(input.hubId, input.userOpenId, input.actorOpenId)
  const remainingHumanMembers = await countHumanMembers(input.hubId)
  if (remainingHumanMembers === 1) {
    await dissolveTeamHubIfSingleMember(input.hubId, input.actorOpenId)
  }
  await writeHubAudit({
    hubId: input.hubId,
    actorOpenId: input.actorOpenId,
    action: "member_remove",
    targetType: "member",
    targetId: input.userOpenId,
    payload: { remainingHumanMembers, transferredOwner },
  })
  return { removed: true, remainingHumanMembers }
}

export async function updateHubMemberRole(input: {
  hubId: string
  actorOpenId: string
  userOpenId: string
  role: HubRole
}): Promise<HubMember> {
  await assertHubPermission(input.actorOpenId, input.hubId, "member:invite")
  const current = await db.queryOne<HubMember>(
    `SELECT * FROM hub_members WHERE hub_id = $1 AND user_open_id = $2`,
    [input.hubId, input.userOpenId],
  )
  if (!current) throw new AppError("Hub member not found", "HUB_MEMBER_NOT_FOUND", { hubId: input.hubId, userOpenId: input.userOpenId })
  if (current.role === "owner_admin" && input.role !== "owner_admin") {
    const ownerCount = await countOwnerAdmins(input.hubId)
    if (ownerCount <= 1) {
      throw new AppError("Cannot demote the last owner_admin; transfer admin first", "HUB_LAST_OWNER_ADMIN", {
        hubId: input.hubId,
        userOpenId: input.userOpenId,
      })
    }
  }

  const rows = await db.query<HubMember>(
    `UPDATE hub_members
     SET role = $3, updated_at = now()
     WHERE hub_id = $1 AND user_open_id = $2
     RETURNING *`,
    [input.hubId, input.userOpenId, input.role],
  )
  await writeHubAudit({
    hubId: input.hubId,
    actorOpenId: input.actorOpenId,
    action: "member_role_update",
    targetType: "member",
    targetId: input.userOpenId,
    payload: { from: current.role, to: input.role },
  })
  return rows[0]
}

export async function transferHubAdmin(input: {
  hubId: string
  actorOpenId: string
  nextOwnerOpenId: string
}): Promise<HubMember> {
  await assertHubPermission(input.actorOpenId, input.hubId, "admin:transfer")
  const rows = await db.query<HubMember>(
    `INSERT INTO hub_members (hub_id, user_open_id, role)
     VALUES ($1, $2, 'owner_admin')
     ON CONFLICT (hub_id, user_open_id)
     DO UPDATE SET role = 'owner_admin', updated_at = now()
     RETURNING *`,
    [input.hubId, input.nextOwnerOpenId],
  )
  await writeHubAudit({
    hubId: input.hubId,
    actorOpenId: input.actorOpenId,
    action: "transfer_admin",
    targetType: "member",
    targetId: input.nextOwnerOpenId,
  })
  return rows[0]
}

export async function assertHubPermission(
  actorOpenId: string | undefined,
  hubId: string,
  action: HubAction,
): Promise<HubMember> {
  if (!actorOpenId) {
    await writeHubAudit({ hubId, actorOpenId: null, action: "denied", targetType: "hub", targetId: hubId, payload: { requestedAction: action, reason: "missing_actor" } })
    throw new AppError("Missing actor identity for Hub operation", "HUB_PERMISSION_DENIED", { hubId, action })
  }

  const member = await db.queryOne<HubMember>(
    `SELECT * FROM hub_members WHERE hub_id = $1 AND user_open_id = $2`,
    [hubId, actorOpenId],
  )
  const hub = await getActiveHub(hubId)
  const isLocalE2eHub = hub.metadata?.source === "local_e2e_seed"
  if (!member && (await countHumanMembers(hubId) === 0 || isLocalE2eHub)) {
    const bootstrapped = await bootstrapOwnerAdmin(hubId, actorOpenId)
    await writeHubAudit({
      hubId,
      actorOpenId,
      action: "bootstrap_owner_admin",
      targetType: "member",
      targetId: actorOpenId,
      payload: { requestedAction: action, localE2e: isLocalE2eHub },
    })
    return bootstrapped
  }
  if (!member || !roleAllows(member.role, action, member.capabilities)) {
    await writeHubAudit({ hubId, actorOpenId, action: "denied", targetType: "hub", targetId: hubId, payload: { requestedAction: action, role: member?.role ?? null } })
    throw new AppError("You do not have permission to perform this Hub operation", "HUB_PERMISSION_DENIED", {
      hubId,
      action,
      actorOpenId,
      role: member?.role ?? null,
    })
  }

  return member
}

export async function ensurePrimaryProjection(workItemId: string, hubId?: string): Promise<string> {
  const hub = hubId ? await getActiveHub(hubId) : await ensureDefaultHub()
  const existing = await db.queryOne<{ id: string }>(
    `SELECT id FROM work_item_hub_projections
     WHERE work_item_id = $1 AND hub_id = $2`,
    [workItemId, hub.id],
  )
  if (existing) return existing.id

  const rows = await db.query<{ id: string }>(
    `INSERT INTO work_item_hub_projections (work_item_id, hub_id, projection_role)
     VALUES ($1, $2, 'primary')
     RETURNING id`,
    [workItemId, hub.id],
  )
  return rows[0].id
}

export async function ensurePersonalHub(userOpenId: string): Promise<ItemHub> {
  const existing = await db.queryOne<ItemHub>(
    `SELECT * FROM item_hubs
     WHERE hub_type = 'personal'
       AND owner_user_id = $1
       AND hub_status = 'active'
     ORDER BY created_at ASC LIMIT 1`,
    [userOpenId],
  )
  if (existing) return existing

  const defaultHub = await ensureDefaultHub()
  const rows = await db.query<ItemHub>(
    `INSERT INTO item_hubs
       (hub_type, name, feishu_base_token, feishu_table_id, owner_user_id, created_by_open_id, metadata)
     VALUES ('personal', $1, $2, $3, $4, $4, $5)
     RETURNING *`,
    [
      `${userOpenId} 的个人事项中枢`,
      defaultHub.feishuBaseToken,
      defaultHub.feishuTableId,
      userOpenId,
      JSON.stringify({ source: "auto_personal_hub", temporarySharedTable: true }),
    ],
  )
  await db.execute(
    `INSERT INTO hub_members (hub_id, user_open_id, role)
     VALUES ($1, $2, 'owner_admin')
     ON CONFLICT (hub_id, user_open_id) DO NOTHING`,
    [rows[0].id, userOpenId],
  )
  await writeHubAudit({
    hubId: rows[0].id,
    actorOpenId: userOpenId,
    action: "personal_hub_created",
    targetType: "hub",
    targetId: rows[0].id,
  })
  return rows[0]
}

export async function updateProjectionRecord(
  projectionId: string,
  recordId: string,
  syncStatus: "synced" | "failed" = "synced",
  lastSyncError?: string,
): Promise<void> {
  await db.execute(
    `UPDATE work_item_hub_projections
     SET bitable_record_id = $2,
         sync_status = $3,
         last_sync_at = now(),
         last_sync_error = $4,
         updated_at = now()
     WHERE id = $1`,
    [projectionId, recordId, syncStatus, lastSyncError ?? null],
  )
}

export async function writeHubAudit(input: {
  hubId?: string | null
  actorOpenId?: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  await db.execute(
    `INSERT INTO hub_audit_log
       (hub_id, actor_open_id, action, target_type, target_id, payload_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.hubId ?? null,
      input.actorOpenId ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  )
}

function roleAllows(role: HubRole, action: HubAction, capabilities: Record<string, unknown>): boolean {
  const override = capabilities[action]
  if (typeof override === "boolean") return override

  if (role === "owner_admin") return true
  if (role === "admin") return action !== "admin:transfer"
  if (role === "editor") return ["hub:read", "item:read", "item:write", "projection:sync"].includes(action)
  if (role === "contributor" || role === "member") return ["hub:read", "item:read", "item:write"].includes(action)
  if (role === "viewer") return ["hub:read", "item:read"].includes(action)
  if (role === "bot") return ["hub:read", "item:read", "projection:sync"].includes(action)
  return false
}

async function countOwnerAdmins(hubId: string): Promise<number> {
  const row = await db.queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM hub_members WHERE hub_id = $1 AND role = 'owner_admin'`,
    [hubId],
  )
  return Number(row?.count ?? 0)
}

async function countHumanMembers(hubId: string): Promise<number> {
  const row = await db.queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM hub_members WHERE hub_id = $1 AND role <> 'bot'`,
    [hubId],
  )
  return Number(row?.count ?? 0)
}

async function bootstrapOwnerAdmin(hubId: string, actorOpenId: string): Promise<HubMember> {
  const rows = await db.query<HubMember>(
    `INSERT INTO hub_members (hub_id, user_open_id, role)
     VALUES ($1, $2, 'owner_admin')
     ON CONFLICT (hub_id, user_open_id)
     DO UPDATE SET role = 'owner_admin', updated_at = now()
     RETURNING *`,
    [hubId, actorOpenId],
  )
  return rows[0]
}

async function transferOwnedItemsAfterMemberRemoval(
  hubId: string,
  removedUserOpenId: string,
  actorOpenId: string,
): Promise<string | null> {
  const successor = await chooseOwnerSuccessor(hubId)
  if (!successor) return null

  const changed = await db.execute(
    `UPDATE work_items wi
     SET owner_user_id = $3,
         owner_source = 'inherited',
         updated_at = now()
     FROM work_item_hub_projections p
     WHERE p.work_item_id = wi.id
       AND p.hub_id = $1
       AND wi.owner_user_id = $2
       AND wi.deleted_at IS NULL
       AND wi.status NOT IN ('done', 'closed')`,
    [hubId, removedUserOpenId, successor],
  )

  await writeHubAudit({
    hubId,
    actorOpenId,
    action: "owner_transfer_after_member_remove",
    targetType: "member",
    targetId: removedUserOpenId,
    payload: { successor, changed },
  })
  return successor
}

async function chooseOwnerSuccessor(hubId: string): Promise<string | null> {
  const row = await db.queryOne<{ userOpenId: string }>(
    `SELECT user_open_id
     FROM hub_members
     WHERE hub_id = $1
       AND role <> 'bot'
     ORDER BY
       CASE role
         WHEN 'owner_admin' THEN 1
         WHEN 'admin' THEN 2
         WHEN 'editor' THEN 3
         WHEN 'member' THEN 4
         WHEN 'contributor' THEN 5
         WHEN 'viewer' THEN 6
         ELSE 9
       END,
       sort_key ASC,
       joined_at ASC
     LIMIT 1`,
    [hubId],
  )
  return row?.userOpenId ?? null
}

async function dissolveTeamHubIfSingleMember(hubId: string, actorOpenId: string): Promise<void> {
  const hub = await getActiveHub(hubId)
  if (hub.hubType !== "team") return

  const survivor = await chooseOwnerSuccessor(hubId)
  if (!survivor) return

  const personalHub = await ensurePersonalHub(survivor)
  await db.execute(
    `INSERT INTO work_item_hub_projections (work_item_id, hub_id, projection_role)
     SELECT p.work_item_id, $2, 'mirror_personal'
     FROM work_item_hub_projections p
     JOIN work_items wi ON wi.id = p.work_item_id
     WHERE p.hub_id = $1
       AND wi.status NOT IN ('done', 'closed')
       AND wi.deleted_at IS NULL
     ON CONFLICT (work_item_id, hub_id)
     DO UPDATE SET projection_role = EXCLUDED.projection_role, updated_at = now()`,
    [hubId, personalHub.id],
  )
  await db.execute(
    `UPDATE work_item_hub_projections
     SET sync_status = 'removed', updated_at = now()
     WHERE hub_id = $1`,
    [hubId],
  )
  await db.execute(
    `UPDATE item_hubs
     SET hub_status = 'dissolved',
         dissolved_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [hubId],
  )
  await writeHubAudit({
    hubId,
    actorOpenId,
    action: "hub_dissolved_single_member",
    targetType: "hub",
    targetId: hubId,
    payload: { survivor, personalHubId: personalHub.id },
  })
}

function sessionKey(chatId: string, actorOpenId: string): string {
  return `hub-session:${chatId}:${actorOpenId}`
}
