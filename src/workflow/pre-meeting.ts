import { task, logger } from "@trigger.dev/sdk"
import { generatePreMeetingBriefFlow } from "../application/source-ingestion-service.js"
import { sendPreMeetingCard } from "../touchpoint/card.js"
import { recordPushRecord } from "../evaluation/push-records.js"
import { failExecution, finishExecution, startExecution } from "../evaluation/execution.js"

interface PreMeetingPayload {
  meetingId: string
  meetingTitle: string
  topicText?: string
  chatId?: string
}

interface PreMeetingResult {
  artifactId: string
  relatedItemCount: number
  messageId: string | null
}

export const preMeetingBrief = task({
  id: "pre-meeting-brief",
  maxDuration: 120,
  retry: { maxAttempts: 2 },

  run: async (payload: PreMeetingPayload): Promise<PreMeetingResult> => {
    logger.info("pre-meeting brief started", { meetingId: payload.meetingId, chatId: payload.chatId })

    const executionId = await startExecution({
      workflowName: "pre-meeting-brief",
      triggerType: "event",
      triggerContextId: payload.meetingId,
    })

    try {
      const result = await generatePreMeetingBriefFlow(payload)
      const messageId = payload.chatId
        ? await sendPreMeetingCard(result.artifact, payload.chatId)
        : null

      if (payload.chatId && messageId) {
        await recordPushRecord({
          artifactId: result.artifact.id,
          channelType: "card",
          targetType: "group",
          targetId: payload.chatId,
          externalMessageId: messageId,
          deliveryStatus: "sent",
        })
      }

      await finishExecution(executionId)
      return {
        artifactId: result.artifact.id,
        relatedItemCount: result.relatedItemCount,
        messageId,
      }
    } catch (error) {
      await failExecution(executionId, error)
      throw error
    }
  },
})
