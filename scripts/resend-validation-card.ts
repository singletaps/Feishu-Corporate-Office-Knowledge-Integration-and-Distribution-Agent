import { db } from "../src/shared/db.js"
import { sendPostMeetingConfirmCard } from "../src/touchpoint/card.js"
import { recordPushRecord } from "../src/evaluation/push-records.js"
import type { WorkItem } from "../src/shared/types.js"

const chatId = "oc_b7359f7826bafdf33d646e038e0e9978"
const originContextId = "mock_real_validation_20260427"

async function main() {
  const items = await db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE origin_context_id = $1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [originContextId],
  )

  if (items.length === 0) {
    throw new Error(`No validation items found for origin_context_id=${originContextId}`)
  }

  const cardMessageId = await sendPostMeetingConfirmCard(items, "MVP模拟验证会议（回调复测）", chatId)
  await recordPushRecord({
    channelType: "card",
    targetType: "group",
    targetId: chatId,
    externalMessageId: cardMessageId,
    deliveryStatus: "sent",
  })

  console.log(JSON.stringify({
    sent: true,
    cardMessageId,
    itemIds: items.map((item) => item.id),
  }, null, 2))
}

main()
  .finally(async () => {
    await db.shutdown()
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
