import { task, logger } from "@trigger.dev/sdk"
import { getMinutesByMeetingId, getMeetingDetail } from "../integration/meeting.js"
import { createFeishuTask } from "../integration/task.js"
import { extractWorkItems, reconcileAndSave } from "../domain/work-item.js"
import { sendPostMeetingConfirmCard } from "../touchpoint/card.js"
import { db } from "../shared/db.js"

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

    const executionId = await recordExecutionStart("post-meeting-extraction", meetingId)

    // Step 1: Fetch meeting detail and minutes
    logger.info("step 1: fetching meeting data", { meetingId })
    const [detail, minutes] = await Promise.all([
      getMeetingDetail(meetingId),
      getMinutesByMeetingId(meetingId),
    ])

    if (!minutes.transcript) {
      logger.warn("no transcript found, skipping extraction", { meetingId })
      await recordExecutionEnd(executionId, "succeeded")
      return { meetingId, meetingTitle: detail.title, extractedCount: 0, savedCount: 0, tasksCreated: [], cardMessageId: null }
    }

    // Step 2: Extract work items via LLM
    logger.info("step 2: extracting work items", { transcriptLength: minutes.transcript.length })
    const extracted = await extractWorkItems(
      minutes.transcript,
      minutes.participants.length > 0 ? minutes.participants : detail.participants,
      "meeting",
      meetingId,
    )

    // Step 3: Reconcile and save to database
    logger.info("step 3: saving to database", { extractedCount: extracted.length })
    const participants = minutes.participants.length > 0 ? minutes.participants : detail.participants
    const saved = await reconcileAndSave(extracted, "meeting", meetingId, participants)

    // Step 4: Create Feishu tasks for high-confidence todos
    logger.info("step 4: creating feishu tasks")
    const tasksCreated: string[] = []
    const todosToCreate = saved.filter(
      (item) => item.itemType === "todo" && !item.needHumanConfirm && item.ownerUserId,
    )

    for (const item of todosToCreate) {
      const result = await createFeishuTask({
        title: item.title,
        ownerOpenId: item.ownerUserId,
        dueAt: item.dueAt,
        description: `来源: 会议「${detail.title}」`,
        sourceLink: null,
      })
      tasksCreated.push(result.taskId)

      await db.execute(
        `INSERT INTO task_bindings (work_item_id, binding_type, external_id, is_primary, binding_role, sync_status)
         VALUES ($1, 'feishu_task', $2, true, 'execution', 'synced')`,
        [item.id, result.taskId],
      )
    }

    // Step 5: Send confirmation card
    let cardMessageId: string | null = null
    if (chatId && saved.length > 0) {
      logger.info("step 5: sending confirmation card", { chatId })
      cardMessageId = await sendPostMeetingConfirmCard(saved, detail.title, chatId)
    }

    await recordExecutionEnd(executionId, "succeeded")

    const result: PostMeetingResult = {
      meetingId,
      meetingTitle: detail.title,
      extractedCount: extracted.length,
      savedCount: saved.length,
      tasksCreated,
      cardMessageId,
    }
    logger.info("post-meeting extraction complete", { ...result })
    return result
  },
})

async function recordExecutionStart(workflowName: string, contextId: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO execution_records (workflow_name, trigger_type, trigger_context_id, status, started_at)
     VALUES ($1, 'event', $2, 'running', now()) RETURNING id`,
    [workflowName, contextId],
  )
  return rows[0].id
}

async function recordExecutionEnd(executionId: string, status: "succeeded" | "failed"): Promise<void> {
  await db.execute(
    `UPDATE execution_records SET status = $2, finished_at = now() WHERE id = $1`,
    [executionId, status],
  )
}
