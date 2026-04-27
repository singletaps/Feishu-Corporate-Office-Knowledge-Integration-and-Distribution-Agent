import { schedules, logger } from "@trigger.dev/sdk"
import { inspectRisksFlow, syncWorkItemHubFlow } from "../application/work-item-service.js"
import { config } from "../shared/config.js"

export const dailyStandup = schedules.task({
  id: "daily-standup",
  cron: { pattern: "0 9 * * *", timezone: "Asia/Shanghai" },
  maxDuration: 180,

  run: async () => {
    logger.info("daily standup started")

    const sync = await syncWorkItemHubFlow(200)
    const risks = await inspectRisksFlow(true)

    return {
      activeCount: sync.activeCount,
      changedCount: sync.changedCount,
      overdueCount: risks.overdueCount,
      blockedCount: risks.blockedCount,
      alertCount: risks.alertedOwnerCount,
      baseUrl: config.feishu.baseUrl,
    }
  },
})
