import { config } from "./shared/config.js"
import { db } from "./shared/db.js"
import { log } from "./evaluation/logger.js"
import { extractWorkItems, reconcileAndSave } from "./domain/index.js"
import type { FeishuUser } from "./shared/types.js"

const MOCK_TRANSCRIPT = `
项目周会纪要 - 2026年4月25日

参会人：张明（产品经理）、李华（研发负责人）、王芳（测试负责人）、赵强（运维）

一、上周进展回顾
张明：上周我们完成了用户反馈模块的需求评审，李华那边开发进度如何？
李华：核心功能已经完成了80%，预计下周三可以提测。但是有一个问题，第三方短信接口的鉴权方式改了，我们需要适配新的接口，这个可能会delay两天。
王芳：我已经准备好了测试用例，一共42个，但是自动化脚本还没写完，需要到周五才能就绪。

二、本周计划讨论
张明：考虑到短信接口的问题，我建议我们把提测时间推迟到下周五4月30号。李华你觉得可以吗？
李华：可以，但需要赵强配合把测试环境的短信网关配置更新一下。
赵强：没问题，我周一上午就处理。
张明：好的，那我们确认几个结论：
1. 提测时间定为4月30号
2. 赵强周一更新测试环境短信网关
3. 王芳周五前完成自动化脚本
4. 如果短信接口适配遇到困难，李华及时反馈

三、风险点
李华：有一个风险需要注意，新的短信接口文档还不完整，如果遇到问题可能需要找对方技术支持，对方响应速度不确定。
张明：这确实是个风险，李华你先评估一下影响范围，如果周二还没搞定就升级到我这里来。
`

const MOCK_PARTICIPANTS: FeishuUser[] = [
  { openId: "ou_zhangming", name: "张明" },
  { openId: "ou_lihua", name: "李华" },
  { openId: "ou_wangfang", name: "王芳" },
  { openId: "ou_zhaoqiang", name: "赵强" },
]

async function main() {
  log.info("=== test extraction start ===")

  log.info("step 1: extracting work items from mock transcript")
  const extracted = await extractWorkItems(
    MOCK_TRANSCRIPT,
    MOCK_PARTICIPANTS,
    "meeting",
    "mock_meeting_001",
  )

  log.info("extracted items", { count: extracted.length })
  for (const item of extracted) {
    log.info("  item", {
      title: item.title,
      type: item.itemType,
      owner: item.ownerName,
      due: item.dueAt,
      priority: item.priority,
      confidence: item.confidenceScore,
    })
  }

  log.info("step 2: saving to database")
  const saved = await reconcileAndSave(extracted, "meeting", "mock_meeting_001", MOCK_PARTICIPANTS)

  log.info("saved items", { count: saved.length })
  for (const item of saved) {
    log.info("  saved", {
      id: item.id,
      title: item.title,
      status: item.status,
      ownerUserId: item.ownerUserId,
    })
  }

  log.info("=== test extraction complete ===")

  await db.shutdown()
  process.exit(0)
}

main().catch((err) => {
  log.error("test failed", { error: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
