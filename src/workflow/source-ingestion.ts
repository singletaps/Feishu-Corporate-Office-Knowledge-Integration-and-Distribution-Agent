import { task, logger } from "@trigger.dev/sdk"
import { ingestSourceItemsFlow } from "../application/source-ingestion-service.js"
import { failExecution, finishExecution, startExecution } from "../evaluation/execution.js"
import type { OriginChannel } from "../shared/types.js"

interface SourceIngestionPayload {
  originChannel: OriginChannel
  originContextId: string
  title?: string
  contentText: string
  ownerUserId?: string
  sourceUrl?: string
  chatId?: string
  chatType?: "group" | "p2p" | "unknown"
  actorOpenId?: string
  mentionedUserIds?: string[]
  docToken?: string
  wikiSpaceId?: string
  folderToken?: string
  calendarEventId?: string
  projectToBase?: boolean
  hubId?: string
}

interface SourceIngestionResult {
  originChannel: OriginChannel
  originContextId: string
  assetId: string
  extractedCount: number
  savedCount: number
  projectedCount: number
}

export const sourceIngestion = task({
  id: "source-ingestion",
  maxDuration: 180,
  retry: { maxAttempts: 2 },

  run: async (payload: SourceIngestionPayload): Promise<SourceIngestionResult> => {
    logger.info("source ingestion started", {
      originChannel: payload.originChannel,
      originContextId: payload.originContextId,
    })

    const executionId = await startExecution({
      workflowName: "source-ingestion",
      triggerType: "event",
      triggerContextId: `${payload.originChannel}:${payload.originContextId}`,
    })

    try {
      const result = await ingestSourceItemsFlow({
        ...payload,
        changedById: "source-ingestion",
      })
      await finishExecution(executionId)
      logger.info("source ingestion complete", { ...result })
      return {
        originChannel: result.originChannel,
        originContextId: result.originContextId,
        assetId: result.assetId,
        extractedCount: result.extractedCount,
        savedCount: result.savedCount,
        projectedCount: result.projectedCount,
      }
    } catch (error) {
      await failExecution(executionId, error)
      throw error
    }
  },
})
