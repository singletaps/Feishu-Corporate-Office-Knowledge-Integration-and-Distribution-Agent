import { extractWorkItems, reconcileAndSave } from "../src/domain/work-item.js"
import { createFeishuTask } from "../src/integration/task.js"
import { projectWorkItemsToBase } from "../src/integration/base.js"
import { sendPostMeetingConfirmCard } from "../src/touchpoint/card.js"
import { recordPushRecord } from "../src/evaluation/push-records.js"
import { db } from "../src/shared/db.js"

const meetingId = "mock_real_validation_20260427"
const chatId = "oc_b7359f7826bafdf33d646e038e0e9978"
const participants = [
  { openId: "ou_8ce96a0c2e3fdc3eaf377a0ecdb79b8c", name: "宗毅" },
]

const transcript = `
MVP 模拟验证会议。
宗毅需要在本周五前完成 FeishuAgent 卡片回调联调，并确认 Base 总表字段映射。
会议决定 OpenClaw 作为 Agent 主体，Trigger.dev 只承担后台调度和补偿。
风险是当前真实会议没有可读取纪要，需要后续提供带纪要的会议样本进行正式评测。
`

async function main() {
  const extracted = await extractWorkItems(transcript, participants, "meeting", meetingId)
  const saved = await reconcileAndSave(extracted, "meeting", meetingId, participants, {
    changedById: "mock-real-validation",
  })

  const tasksCreated: string[] = []
  for (const item of saved.filter((it) => it.itemType === "todo" && !it.needHumanConfirm && it.ownerUserId)) {
    const task = await createFeishuTask({
      title: item.title,
      ownerOpenId: item.ownerUserId,
      dueAt: item.dueAt,
      description: "来源: MVP模拟验证会议",
      sourceLink: null,
    })
    if (task.taskId) tasksCreated.push(task.taskId)
  }

  await projectWorkItemsToBase(saved)
  const cardMessageId = await sendPostMeetingConfirmCard(saved, "MVP模拟验证会议", chatId)
  await recordPushRecord({
    channelType: "card",
    targetType: "group",
    targetId: chatId,
    externalMessageId: cardMessageId,
    deliveryStatus: "sent",
  })

  console.log(JSON.stringify({
    extractedCount: extracted.length,
    savedCount: saved.length,
    tasksCreated,
    cardMessageId,
    itemIds: saved.map((item) => item.id),
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
