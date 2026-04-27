import { task, logger } from "@trigger.dev/sdk"
import { handleCardCallback, type CardCallbackPayload } from "../application/card-callback-service.js"
import { failExecution, finishExecution, startExecution } from "../evaluation/execution.js"

export const cardCallbackFlow = task({
  id: "card-callback",
  maxDuration: 60,
  retry: { maxAttempts: 1 },

  run: async (payload: CardCallbackPayload) => {
    const executionId = await startExecution({
      workflowName: "card-callback",
      triggerType: "card_callback",
      triggerContextId: payload.open_message_id,
    })

    try {
      logger.info("card callback started", { messageId: payload.open_message_id })
      const result = await handleCardCallback(payload)
      await finishExecution(executionId)
      logger.info("card callback complete", result)
      return result
    } catch (error) {
      await failExecution(executionId, error)
      throw error
    }
  },
})
