import { task, logger } from "@trigger.dev/sdk"
import { inspectRisksFlow } from "../application/work-item-service.js"

interface RiskInspectionPayload {
  sendAlerts?: boolean
}

interface RiskInspectionResult {
  overdueCount: number
  blockedCount: number
  alertedOwnerCount: number
  projectedCount: number
}

export const riskInspection = task({
  id: "risk-inspection",
  maxDuration: 120,
  retry: { maxAttempts: 2 },

  run: async (payload: RiskInspectionPayload = {}): Promise<RiskInspectionResult> => {
    const sendAlerts = payload.sendAlerts ?? false
    logger.info("risk inspection started", { sendAlerts })

    const result = await inspectRisksFlow(sendAlerts)

    logger.info("risk inspection complete", { ...result })
    return result
  },
})
