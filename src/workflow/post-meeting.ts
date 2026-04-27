import { task, logger } from "@trigger.dev/sdk"
import { extractMeetingItemsFlow } from "../application/work-item-service.js"
import { failExecution, finishExecution, startExecution } from "../evaluation/execution.js"

interface PostMeetingPayload {
  meetingId: string
  chatId?: string
}

interface PostMeetingResult {
  meetingId: string
  meetingTitle: string
  extractedCount: number
  savedCount: number
  tasksCreated: string[]
  cardMessageId: string | null
}

export const postMeetingExtraction = task({
  id: "post-meeting-extraction",
  maxDuration: 120,
  retry: { maxAttempts: 2 },

  run: async (payload: PostMeetingPayload): Promise<PostMeetingResult> => {
    const { meetingId, chatId } = payload
    logger.info("post-meeting extraction started", { meetingId })

    const executionId = await startExecution({
      workflowName: "post-meeting-extraction",
      triggerType: "event",
      triggerContextId: meetingId,
    })

    try {
      const result = await extractMeetingItemsFlow({
        meetingId,
        chatId,
        sendCard: Boolean(chatId),
        createTasks: true,
        projectToBase: true,
        changedById: "post-meeting-extraction",
      })

      await finishExecution(executionId)

      const workflowResult: PostMeetingResult = {
        meetingId,
        meetingTitle: result.meetingTitle,
        extractedCount: result.extractedCount,
        savedCount: result.savedCount,
        tasksCreated: result.tasksCreated,
        cardMessageId: result.cardMessageId,
      }
      logger.info("post-meeting extraction complete", { ...workflowResult })
      return workflowResult
    } catch (error) {
      await failExecution(executionId, error)
      throw error
    }
  },
})
