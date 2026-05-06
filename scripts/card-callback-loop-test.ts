import assert from "node:assert/strict"

process.env.DATABASE_URL ??= "postgres://feishu:feishu@localhost:5432/feishu_agent"
process.env.REDIS_URL ??= "redis://127.0.0.1:6379"
process.env.FEISHU_APP_ID ??= "local-card-loop-app"
process.env.FEISHU_BASE_TOKEN ??= "local-base-token"
process.env.FEISHU_BASE_TABLE_ID ??= "local-table-id"
process.env.FEISHU_BASE_URL ??= "https://example.feishu.local"
process.env.LOG_LEVEL ??= "warn"

const { handleCardCallback } = await import("../src/application/card-callback-service.js")
const { db } = await import("../src/shared/db.js")

const runId = `card-loop-${Date.now()}`
const actorId = "ou_local_card_actor"

type DbWorkItem = {
  id: string
  title: string
  status: string
  priority: string | null
  ownerUserId: string | null
  needHumanConfirm: boolean
}

type DbPushRecord = {
  clicked: boolean
  deliveryStatus: string
  acknowledgedAt: Date | null
  renderedPayload: Record<string, unknown> | null
}

async function main(): Promise<void> {
  await cleanup()

  try {
    const confirmOne = await seedWorkItem("确认单条事项", "decision", "pending_review")
    await seedReviewTask(confirmOne.id)
    await seedPushRecord("msg-confirm")
    await handleCardCallback(callbackPayload("workitem.confirm", confirmOne.id, "msg-confirm"))
    await expectItem(confirmOne.id, { status: "active", needHumanConfirm: false })
    await expectAudit(confirmOne.id, "status_change", "status")
    await expectPush("msg-confirm", "workitem.confirm", confirmOne.id)

    const confirmAllA = await seedWorkItem("全部确认 A", "decision", "pending_review")
    const confirmAllB = await seedWorkItem("全部确认 B", "risk", "pending_review")
    await seedPushRecord("msg-confirm-all")
    await handleCardCallback({
      event: {
        operator: { open_id: actorId },
        context: { open_message_id: "msg-confirm-all", open_chat_id: "oc_local_group" },
        action: { value: { action: "workitem.confirm_all", workItemIds: [confirmAllA.id, confirmAllB.id] } },
      },
    })
    await expectItem(confirmAllA.id, { status: "active" })
    await expectItem(confirmAllB.id, { status: "active" })
    await expectPush("msg-confirm-all", "workitem.confirm_all", null)

    const rejected = await seedWorkItem("驳回事项", "risk", "pending_review")
    await seedReviewTask(rejected.id)
    await seedPushRecord("msg-reject")
    await handleCardCallback(callbackPayload("reject", rejected.id, "msg-reject"))
    await expectItem(rejected.id, { status: "closed", needHumanConfirm: false })
    await expectReviewStatus(rejected.id, "rejected")
    await expectPush("msg-reject", "workitem.reject", rejected.id)

    const revised = await seedWorkItem("原始标题", "todo", "pending_review")
    await seedReviewTask(revised.id)
    await seedPushRecord("msg-edit")
    await handleCardCallback({
      event: {
        operator: { open_id: actorId },
        context: { open_message_id: "msg-edit", open_chat_id: "oc_local_group" },
        action: {
          value: { action: "modify", workItemId: revised.id },
          form_value: {
            title: "修订后标题",
            priority: "high",
            ownerUserId: "ou_local_owner",
            dueDate: "2026-05-20",
            detail: "本地回环修订详情",
          },
        },
      },
    })
    await expectItem(revised.id, {
      title: "修订后标题",
      status: "active",
      priority: "high",
      ownerUserId: "ou_local_owner",
      needHumanConfirm: false,
    })
    await expectAudit(revised.id, "field_update", "title")
    await expectReviewStatus(revised.id, "revised")
    await expectPush("msg-edit", "workitem.edit", revised.id)

    const claimed = await seedWorkItem("待认领风险", "risk", "blocked", null)
    await seedPushRecord("msg-claim")
    await handleCardCallback(callbackPayload("claim", claimed.id, "msg-claim"))
    await expectItem(claimed.id, { status: "blocked", ownerUserId: actorId })
    await expectAudit(claimed.id, "field_update", "owner_user_id")
    await expectPush("msg-claim", "workitem.claim_risk", claimed.id)

    console.log("card callback loop test passed")
  } finally {
    await cleanup()
    await db.shutdown()
  }
}

function callbackPayload(action: string, workItemId: string, messageId: string): Record<string, unknown> {
  return {
    event: {
      operator: { open_id: actorId },
      context: { open_message_id: messageId, open_chat_id: "oc_local_group" },
      action: { value: { action, workItemId } },
    },
  }
}

async function seedWorkItem(
  title: string,
  itemType: "todo" | "decision" | "risk" | "blocker",
  status: "new" | "pending_review" | "active" | "blocked" | "done" | "closed",
  ownerUserId = "ou_existing_owner",
): Promise<DbWorkItem> {
  const rows = await db.query<DbWorkItem>(
    `INSERT INTO work_items
       (title, item_type, status, priority, owner_user_id, owner_source,
        confidence_score, need_human_confirm, origin_channel, origin_context_id,
        dedupe_key, metadata, first_detected_at, last_detected_at)
     VALUES ($1, $2, $3, 'medium', $4, $5, 0.4, $6, 'meeting', $7, $8, '{}'::jsonb, now(), now())
     RETURNING id, title, status, priority, owner_user_id, need_human_confirm`,
    [
      title,
      itemType,
      status,
      ownerUserId,
      ownerUserId ? "inferred" : null,
      status === "pending_review",
      runId,
      `${runId}:${title}`,
    ],
  )
  return rows[0]
}

async function seedReviewTask(workItemId: string): Promise<void> {
  await db.execute(
    `INSERT INTO human_review_tasks (target_type, target_id, review_reason)
     VALUES ('work_item', $1, 'local card callback loop')`,
    [workItemId],
  )
}

async function seedPushRecord(messageId: string): Promise<void> {
  await db.execute(
    `INSERT INTO push_records
       (channel_type, target_type, target_id, external_message_id, delivery_status, sent_at)
     VALUES ('card', 'group', 'oc_local_group', $1, 'sent', now())`,
    [messageId],
  )
}

async function expectItem(workItemId: string, expected: Partial<DbWorkItem>): Promise<void> {
  const item = await db.queryOne<DbWorkItem>(
    `SELECT id, title, status, priority, owner_user_id, need_human_confirm
     FROM work_items WHERE id = $1`,
    [workItemId],
  )
  assert.ok(item, `expected work item ${workItemId}`)
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(item[key as keyof DbWorkItem], value, `work item ${key}`)
  }
}

async function expectAudit(workItemId: string, changeType: string, fieldName: string): Promise<void> {
  const row = await db.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM work_item_audit_log
     WHERE work_item_id = $1 AND change_type = $2 AND field_name = $3`,
    [workItemId, changeType, fieldName],
  )
  assert.notEqual(row?.count, "0", `expected ${changeType}/${fieldName} audit for ${workItemId}`)
}

async function expectReviewStatus(workItemId: string, reviewStatus: string): Promise<void> {
  const row = await db.queryOne<{ reviewStatus: string }>(
    `SELECT review_status
     FROM human_review_tasks
     WHERE target_type = 'work_item' AND target_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [workItemId],
  )
  assert.equal(row?.reviewStatus, reviewStatus, `review status for ${workItemId}`)
}

async function expectPush(messageId: string, action: string, workItemId: string | null): Promise<void> {
  const push = await db.queryOne<DbPushRecord>(
    `SELECT clicked, delivery_status, acknowledged_at, rendered_payload
     FROM push_records WHERE external_message_id = $1`,
    [messageId],
  )
  assert.ok(push, `expected push record ${messageId}`)
  assert.equal(push.clicked, true, "push clicked")
  assert.equal(push.deliveryStatus, "acknowledged", "push delivery status")
  assert.ok(push.acknowledgedAt, "push acknowledged_at")
  assert.equal(push.renderedPayload?.lastCardAction, action, "push action")
  if (workItemId) assert.equal(push.renderedPayload?.lastCardWorkItemId, workItemId, "push work item id")
}

async function cleanup(): Promise<void> {
  await db.execute(
    `DELETE FROM human_review_tasks
     WHERE target_type = 'work_item'
       AND target_id IN (SELECT id FROM work_items WHERE origin_context_id = $1)`,
    [runId],
  )
  await db.execute(`DELETE FROM work_items WHERE origin_context_id = $1`, [runId])
  await db.execute(`DELETE FROM push_records WHERE external_message_id LIKE 'msg-%'`, [])
}

main().catch(async (error: unknown) => {
  console.error(error)
  await db.shutdown()
  process.exitCode = 1
})
