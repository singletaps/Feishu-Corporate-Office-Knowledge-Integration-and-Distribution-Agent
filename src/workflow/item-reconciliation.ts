import { task, logger } from "@trigger.dev/sdk"
import { syncWorkItemHubFlow } from "../application/work-item-service.js"

interface ItemReconciliationPayload {
  limit?: number
}

interface ItemReconciliationResult {
  activeCount: number
  taskBindingCount: number
  changedCount: number
  projectedCount: number
}

export const itemReconciliation = task({
  id: "item-reconciliation",
  maxDuration: 180,
  retry: { maxAttempts: 2 },

  run: async (payload: ItemReconciliationPayload = {}): Promise<ItemReconciliationResult> => {
    const limit = payload.limit ?? 200
    logger.info("item reconciliation started", { limit })

    const result = await syncWorkItemHubFlow(limit)

    logger.info("item reconciliation complete", { ...result })
    return result
  },
})
