import { schedules, logger } from "@trigger.dev/sdk"
import { listActiveItems } from "../domain/work-item.js"
import { generateWeeklyInsight } from "../domain/artifact.js"
import { sendWeeklyInsightCard } from "../touchpoint/card.js"
import { config } from "../shared/config.js"

export const weeklyInsight = schedules.task({
  id: "weekly-insight",
  cron: { pattern: "0 18 * * 5", timezone: "Asia/Shanghai" },
  maxDuration: 180,

  run: async () => {
    logger.info("weekly insight started")

    const now = new Date()
    const from = new Date(now)
    from.setDate(now.getDate() - 7)

    const items = await listActiveItems({ limit: 200 })
    const artifact = await generateWeeklyInsight({ from, to: now }, items)

    const messageId = config.notifications.defaultChatId
      ? await sendWeeklyInsightCard(artifact, config.notifications.defaultChatId)
      : null

    return {
      artifactId: artifact.id,
      itemCount: items.length,
      messageId,
      baseUrl: config.feishu.baseUrl,
    }
  },
})
