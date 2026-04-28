import { tasks } from "@trigger.dev/sdk"
import { redis } from "../shared/redis.js"
import { log } from "../evaluation/logger.js"
import { AppError } from "../shared/errors.js"
import type { TriggerEvent } from "../shared/types.js"
import { callAgent } from "../domain/openclaw-client.js"
import { sendCardToChat, sendTextToChat } from "../integration/message.js"
import { bindHubSession, findBoundHubForChat, resolveHubForChat } from "../application/hub-service.js"
import { executeHubCommand } from "../application/hub-command-service.js"
import { handleCardCallback as processCardCallback } from "../application/card-callback-service.js"
import { mapFeishuEventToInboundRoute } from "./feishu-ingestion-adapter.js"
import type { postMeetingExtraction } from "../workflow/post-meeting.js"
import type { sourceIngestion } from "../workflow/source-ingestion.js"
import type { preMeetingBrief } from "../workflow/pre-meeting.js"

const IDEMPOTENCY_TTL = 3600
type EventHandler = (event: TriggerEvent) => Promise<{ dispatched: boolean; runId?: string }>

const eventHandlers: Record<string, EventHandler> = {
  "vc.meeting.meeting_ended_v1": handleMeetingEnd,
  meeting_end: handleMeetingEnd,
  "vc.meeting.meeting_started_v1": handleMeetingStart,
  meeting_start: handleMeetingStart,
  "card.action.trigger": handleCardCallback,
  card_callback: handleCardCallback,
  "im.message.receive_v1": handleSourceIngestionEvent,
  im_message: handleSourceIngestionEvent,
  doc_update: handleSourceIngestionEvent,
  wiki_update: handleSourceIngestionEvent,
  task_update: handleSourceIngestionEvent,
  mail_received: handleSourceIngestionEvent,
}

export async function dispatchToWorkflow(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const isDuplicate = await checkIdempotency(event.idempotencyKey)
  if (isDuplicate) {
    log.info("duplicate event, skipping", { eventId: event.eventId, key: event.idempotencyKey })
    return { dispatched: false }
  }

  await markProcessed(event.idempotencyKey)

  const handler = eventHandlers[event.eventType]
  if (!handler) {
    log.info("unhandled event type, ignoring", { eventType: event.eventType })
    return { dispatched: false }
  }
  return handler(event)
}

async function handleMeetingEnd(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload as Record<string, unknown>
  const meeting = payload.meeting as Record<string, unknown> | undefined
  const meetingId = (meeting?.id as string) ?? (payload.meeting_id as string) ?? ""
  const chatId = (meeting?.meeting_chat_id as string) ?? (payload.chat_id as string) ?? ""

  if (!meetingId) {
    log.warn("meeting_end event without meeting_id", { eventId: event.eventId })
    return { dispatched: false }
  }

  log.info("dispatching post-meeting extraction", { meetingId, chatId })

  const handle = await tasks.trigger<typeof postMeetingExtraction>("post-meeting-extraction", {
    meetingId,
    chatId: chatId || undefined,
  })

  log.info("workflow dispatched", { runId: handle.id, meetingId })
  return { dispatched: true, runId: handle.id }
}

async function handleMeetingStart(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload as Record<string, unknown>
  const meeting = payload.meeting as Record<string, unknown> | undefined
  const meetingId = (meeting?.id as string) ?? (payload.meeting_id as string) ?? ""
  const meetingTitle = (meeting?.title as string) ?? (payload.title as string) ?? "未命名会议"
  const chatId = (meeting?.meeting_chat_id as string) ?? (payload.chat_id as string) ?? ""
  const topicText = (meeting?.description as string) ?? (payload.description as string) ?? ""

  if (!meetingId) {
    log.warn("meeting_start event without meeting_id", { eventId: event.eventId })
    return { dispatched: false }
  }

  const handle = await tasks.trigger<typeof preMeetingBrief>("pre-meeting-brief", {
    meetingId,
    meetingTitle,
    topicText: topicText || undefined,
    chatId: chatId || undefined,
  })

  log.info("pre-meeting brief workflow dispatched", { runId: handle.id, meetingId, chatId })
  return { dispatched: true, runId: handle.id }
}

async function handleCardCallback(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const payload = event.payload.event && typeof event.payload.event === "object"
    ? event.payload
    : { event: event.payload }
  try {
    const result = await processCardCallback(payload)
    log.info("card callback handled", { eventId: event.eventId, ...result })
    return { dispatched: true }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const code = error instanceof AppError ? error.code : "CARD_CALLBACK_FAILED"
    const context = event.payload as { context?: { open_chat_id?: string }; event?: { context?: { open_chat_id?: string } } }
    const chatId = context.event?.context?.open_chat_id ?? context.context?.open_chat_id
    log.error("card callback failed", {
      eventId: event.eventId,
      error: err.message,
      code,
      context: error instanceof AppError ? error.context : undefined,
    })
    if (chatId) {
      await sendTextToChat(chatId, `卡片回调失败：${err.message}\n错误码：${code}`)
    }
    return { dispatched: true }
  }
}

async function handleSourceIngestionEvent(event: TriggerEvent): Promise<{ dispatched: boolean; runId?: string }> {
  const route = mapFeishuEventToInboundRoute(event)

  if (route.kind === "ignore") {
    log.info("inbound event ignored", {
      eventId: event.eventId,
      eventType: event.eventType,
      reason: route.reason,
    })
    return { dispatched: false }
  }

  if (route.kind === "pending_pull") {
    log.warn("inbound event requires follow-up pull before ingestion", {
      eventId: event.eventId,
      eventType: route.eventType,
      originChannel: route.originChannel,
      originContextId: route.originContextId,
      reason: route.reason,
    })
    return { dispatched: false }
  }

  if (route.kind === "help") {
    await sendTextToChat(route.chatId, buildInboundHelpText(route.actorOpenId))
    log.info("inbound help message handled", { eventId: event.eventId, chatId: route.chatId })
    return { dispatched: true }
  }

  if (route.kind === "agent_question") {
    const reply = await callAgent([
      {
        role: "system",
        content: [
          "你是 FeishuAgent 的方向 D 事项中枢助手。",
          "优先围绕当前群的事项、风险、阻塞、负责人和推进表进行回答。",
          "如需执行写操作，应通过已注册 agent-tools，并返回清晰的人类可读结果。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `actorOpenId: ${route.actorOpenId ?? "unknown"}`,
          `chatId: ${route.chatId}`,
          `messageId: ${route.messageId}`,
          `question: ${route.question}`,
        ].join("\n"),
      },
    ])
    await sendTextToChat(route.chatId, reply.content)
    log.info("inbound agent question handled", { eventId: event.eventId, chatId: route.chatId })
    return { dispatched: true }
  }

  if (route.kind === "hub_command") {
    if (route.command === "execute" && route.hubCommand) {
      const hub = await resolveInboundHub(route.chatId, route.actorOpenId)
      if (!hub) return { dispatched: true }
      const reply = await executeHubCommandWithReply(route.chatId, {
        hubId: hub.id,
        actorOpenId: route.actorOpenId,
        command: route.hubCommand,
      })
      if (reply.kind === "card") {
        try {
          await sendCardToChat(route.chatId, reply.card)
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error))
          const code = error instanceof AppError ? error.code : "SEND_CARD_FAILED"
          log.error("hub command card send failed", {
            chatId: route.chatId,
            hubId: hub.id,
            command: route.hubCommand.command,
            error: err.message,
            code,
          })
          await sendTextToChat(route.chatId, `卡片发送失败：${err.message}\n错误码：${code}`)
        }
      } else {
        await sendTextToChat(route.chatId, reply.text)
      }
      return { dispatched: true }
    }
    if (route.command === "select_hub" && route.hubId && route.actorOpenId) {
      await bindHubSession(route.chatId, route.actorOpenId, route.hubId)
      await sendTextToChat(route.chatId, `已选择当前 Hub：${route.hubId}`)
      return { dispatched: true }
    }
    const hub = await resolveHubForChat(route.chatId, route.actorOpenId)
    await sendTextToChat(route.chatId, [
      `当前 Hub：${hub.name}`,
      `Hub ID：${hub.id}`,
      `类型：${hub.hubType}`,
      "",
      buildInboundHelpText(route.actorOpenId),
    ].join("\n"))
    return { dispatched: true }
  }

  const hub = route.chatId ? await findBoundHubForChat(route.chatId) : null
  const handle = await tasks.trigger<typeof sourceIngestion>("source-ingestion", {
    ...route.payload,
    chatId: route.chatId,
    actorOpenId: route.actorOpenId,
    hubId: hub?.id,
  })

  log.info("source ingestion workflow dispatched", {
    runId: handle.id,
    originChannel: route.payload.originChannel,
    originContextId: route.payload.originContextId,
    chatId: route.chatId,
    hubId: hub?.id,
  })
  return { dispatched: true, runId: handle.id }
}

async function checkIdempotency(key: string): Promise<boolean> {
  const exists = await redis.exists(`idemp:${key}`)
  return exists === 1
}

async function markProcessed(key: string): Promise<void> {
  await redis.setex(`idemp:${key}`, IDEMPOTENCY_TTL, "1")
}

function buildInboundHelpText(actorOpenId?: string): string {
  return [
    "FeishuAgent 事项中枢可用操作：",
    "- /help：查看当前帮助。",
    "- /list：查看当前 Hub 待办。",
      "- /all：生成当前 Hub 全部 WorkItem 电子表格。",
    "- /add <标题>：新增待办。",
    "- /update <WorkItem ID> <新标题>：修改待办标题。",
    "- /delete <WorkItem ID>：删除待办。",
    "- /invite <open_id> [role]：邀请成员，role 可选 member/admin/editor/viewer。",
    "- /remove-member <open_id>：移除成员。",
    "- @机器人 总结当前阻塞事项：进入 OpenClaw 问询与工具编排。",
    "- /hub：查看当前 Hub。",
    "- /select-hub <hubId>：在多 Hub 群里短期选择当前 Hub。",
    "- 在群消息中包含待办、任务、风险、阻塞、负责人等关键词：作为事项来源进入摄入流程。",
    "",
    `当前用户：${actorOpenId ?? "未知"}`,
    "当前 Hub：首期使用默认 Hub；多 Hub 解析与权限将在下一阶段接入。",
  ].join("\n")
}

async function executeHubCommandWithReply(
  chatId: string,
  input: Parameters<typeof executeHubCommand>[0],
): Promise<Awaited<ReturnType<typeof executeHubCommand>>> {
  try {
    return await executeHubCommand(input)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error("hub command failed", {
      chatId,
      hubId: input.hubId,
      command: input.command.command,
      error: err.message,
      code: error instanceof AppError ? error.code : undefined,
    })
    if (error instanceof AppError) {
      return { kind: "text", text: `操作失败：${error.message}\n错误码：${error.code}` }
    }
    return { kind: "text", text: `操作失败：${err.message}` }
  }
}

async function resolveInboundHub(chatId: string, actorOpenId?: string) {
  try {
    return await resolveHubForChat(chatId, actorOpenId)
  } catch (error) {
    if (error instanceof AppError && error.code === "HUB_AMBIGUOUS") {
      const candidates = Array.isArray(error.context?.candidates) ? error.context.candidates : []
      const lines = candidates.map((candidate) => {
        const item = candidate as { id?: string; name?: string; hubType?: string }
        return `- ${item.name ?? "未命名 Hub"} (${item.hubType ?? "unknown"}): ${item.id}`
      })
      await sendTextToChat(chatId, [
        "当前群绑定了多个 Hub，请先选择后再操作：",
        ...lines,
        "",
        "用法：/select-hub <hubId>",
      ].join("\n"))
      return null
    }
    throw error
  }
}
