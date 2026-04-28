import "dotenv/config"
import pg from "pg"

const databaseUrl = requireEnv("DATABASE_URL")
const baseToken = requireEnv("FEISHU_BASE_TOKEN")
const baseTableId = requireEnv("FEISHU_BASE_TABLE_ID")
const defaultChatId = process.env.FEISHU_DEFAULT_CHAT_ID ?? null

const TEST_USER_OPEN_ID = "ou_local_test_user"
const TEST_TEAM_MEMBER_OPEN_ID = "ou_local_team_member"
const TEST_TEAM_CHAT_ID = "oc_local_test_team"

const client = new pg.Client({ connectionString: databaseUrl })

await client.connect()
try {
  await migrateHubSchema()
  const defaultHubId = await ensureHub({
    hubType: "legacy",
    name: "默认事项中枢",
    ownerUserId: null,
    defaultChatId,
    metadata: { source: "local_e2e_seed", role: "default" },
  })
  const personalHubId = await ensureHub({
    hubType: "personal",
    name: "本地测试用户个人事项中枢",
    ownerUserId: TEST_USER_OPEN_ID,
    defaultChatId: null,
    metadata: { source: "local_e2e_seed", role: "personal" },
  })
  const teamHubId = await ensureHub({
    hubType: "team",
    name: "本地测试团队 Hub",
    ownerUserId: null,
    defaultChatId: TEST_TEAM_CHAT_ID,
    metadata: { source: "local_e2e_seed", role: "team" },
  })

  await ensureMember(defaultHubId, TEST_USER_OPEN_ID, "owner_admin")
  await ensureMember(personalHubId, TEST_USER_OPEN_ID, "owner_admin")
  await ensureMember(teamHubId, TEST_USER_OPEN_ID, "owner_admin")
  await ensureMember(teamHubId, TEST_TEAM_MEMBER_OPEN_ID, "member")

  await ensureWorkItem({
    hubId: personalHubId,
    title: "本地测试用户个人待办：整理机器人测试反馈",
    ownerUserId: TEST_USER_OPEN_ID,
    dedupeKey: "local-e2e:personal:feedback",
    projectionRole: "primary",
  })
  await ensureWorkItem({
    hubId: teamHubId,
    title: "本地测试团队待办：验证群任务分发与归并",
    ownerUserId: TEST_USER_OPEN_ID,
    dedupeKey: "local-e2e:team:distribution",
    projectionRole: "primary",
  })
  await ensureWorkItem({
    hubId: personalHubId,
    title: "本地测试镜像待办：跟进团队 Hub 任务",
    ownerUserId: TEST_USER_OPEN_ID,
    dedupeKey: "local-e2e:mirror:team-followup",
    projectionRole: "mirror_personal",
  })

  console.log(JSON.stringify({
    ok: true,
    testUserOpenId: TEST_USER_OPEN_ID,
    testTeamMemberOpenId: TEST_TEAM_MEMBER_OPEN_ID,
    defaultHubId,
    personalHubId,
    teamHubId,
    testTeamChatId: TEST_TEAM_CHAT_ID,
  }, null, 2))
} finally {
  await client.end()
}

async function migrateHubSchema(): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS item_hubs (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      hub_type TEXT NOT NULL CHECK (hub_type IN ('team', 'personal', 'org', 'legacy')),
      name TEXT NOT NULL,
      feishu_base_token TEXT NOT NULL,
      feishu_table_id TEXT NOT NULL,
      default_chat_id TEXT,
      owner_user_id TEXT,
      created_by_open_id TEXT,
      hub_status TEXT NOT NULL DEFAULT 'active' CHECK (hub_status IN ('active', 'archived', 'dissolved')),
      dissolved_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hub_members (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      hub_id UUID NOT NULL REFERENCES item_hubs(id) ON DELETE CASCADE,
      user_open_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner_admin', 'admin', 'editor', 'contributor', 'viewer', 'member', 'bot')),
      capabilities JSONB DEFAULT '{}'::jsonb,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sort_key INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS work_item_hub_projections (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      work_item_id UUID NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      hub_id UUID NOT NULL REFERENCES item_hubs(id) ON DELETE CASCADE,
      projection_role TEXT NOT NULL CHECK (projection_role IN ('primary', 'mirror_personal', 'mirror_team')),
      bitable_record_id TEXT,
      sync_status TEXT DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'conflict', 'failed', 'removed')),
      last_sync_at TIMESTAMPTZ,
      last_sync_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS hub_audit_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      hub_id UUID REFERENCES item_hubs(id) ON DELETE SET NULL,
      actor_open_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      payload_json JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_members_unique ON hub_members(hub_id, user_open_id)`)
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_hub_projection_unique ON work_item_hub_projections(work_item_id, hub_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_hub_audit_hub ON hub_audit_log(hub_id, created_at)`)
  await client.query(`ALTER TABLE task_bindings ADD COLUMN IF NOT EXISTS hub_id UUID`)
  await client.query(`ALTER TABLE task_bindings ADD COLUMN IF NOT EXISTS projection_id UUID`)
}

async function ensureHub(input: {
  hubType: "legacy" | "personal" | "team"
  name: string
  ownerUserId: string | null
  defaultChatId: string | null
  metadata: Record<string, unknown>
}): Promise<string> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM item_hubs
     WHERE hub_type = $1
       AND name = $2
       AND hub_status = 'active'
     LIMIT 1`,
    [input.hubType, input.name],
  )
  if (existing.rows[0]) return existing.rows[0].id

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO item_hubs
       (hub_type, name, feishu_base_token, feishu_table_id, default_chat_id, owner_user_id, created_by_open_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7)
     RETURNING id`,
    [input.hubType, input.name, baseToken, baseTableId, input.defaultChatId, input.ownerUserId, JSON.stringify(input.metadata)],
  )
  return inserted.rows[0].id
}

async function ensureMember(hubId: string, userOpenId: string, role: string): Promise<void> {
  await client.query(
    `INSERT INTO hub_members (hub_id, user_open_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (hub_id, user_open_id)
     DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
    [hubId, userOpenId, role],
  )
}

async function ensureWorkItem(input: {
  hubId: string
  title: string
  ownerUserId: string
  dedupeKey: string
  projectionRole: "primary" | "mirror_personal"
}): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM work_items WHERE dedupe_key = $1 AND deleted_at IS NULL LIMIT 1`,
    [input.dedupeKey],
  )
  const workItemId = existing.rows[0]?.id ?? (await client.query<{ id: string }>(
    `INSERT INTO work_items
       (title, item_type, status, priority, owner_user_id, owner_source, confidence_score,
        need_human_confirm, origin_channel, origin_context_id, dedupe_key, metadata,
        first_detected_at, last_detected_at)
     VALUES ($1, 'todo', 'new', 'medium', $2, 'manual', 1, false, 'im', $3, $4, $5, now(), now())
     RETURNING id`,
    [
      input.title,
      input.ownerUserId,
      `local-e2e:${input.dedupeKey}`,
      input.dedupeKey,
      JSON.stringify({ source: "local_e2e_seed" }),
    ],
  )).rows[0].id

  await client.query(
    `INSERT INTO work_item_hub_projections (work_item_id, hub_id, projection_role)
     VALUES ($1, $2, $3)
     ON CONFLICT (work_item_id, hub_id)
     DO UPDATE SET projection_role = EXCLUDED.projection_role, updated_at = now()`,
    [workItemId, input.hubId, input.projectionRole],
  )
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}
