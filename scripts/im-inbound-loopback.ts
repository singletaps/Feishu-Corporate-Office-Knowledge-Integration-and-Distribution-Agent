import { strict as assert } from "node:assert"
import type { TriggerEvent } from "../src/shared/types.js"

setLoopbackEnv()

const CHAT_ID = "oc_loopback_chat"
const ACTOR_OPEN_ID = "ou_loopback_actor"

type InboundMapper = typeof import("../src/trigger/feishu-ingestion-adapter.js")["mapFeishuEventToInboundRoute"]
type OriginChannelValues = typeof import("../src/shared/types.js")["OriginChannel"]
type MessageModule = typeof import("../src/integration/message.js")

function setLoopbackEnv(): void {
  process.env.DATABASE_URL ??= "postgres://loopback:loopback@127.0.0.1:5432/loopback"
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379"
  process.env.FEISHU_APP_ID ??= "cli_loopback_app"
  process.env.FEISHU_BASE_TOKEN ??= "base_loopback"
  process.env.FEISHU_BASE_TABLE_ID ??= "table_loopback"
  process.env.FEISHU_BASE_URL ??= "https://example.feishu.cn/base/loopback"
  process.env.LOG_LEVEL ??= "error"
}

function imEvent(text: string, overrides: Partial<TriggerEvent["payload"]> = {}): TriggerEvent {
  const messageId = `om_${Math.random().toString(16).slice(2)}`
  return {
    eventId: `evt_${messageId}`,
    eventType: "im.message.receive_v1",
    source: "feishu_event",
    idempotencyKey: `idem_${messageId}`,
    occurredAt: new Date("2026-05-06T00:00:00.000Z"),
    receivedAt: new Date("2026-05-06T00:00:01.000Z"),
    payload: {
      sender: { sender_id: { open_id: ACTOR_OPEN_ID } },
      message: {
        message_id: messageId,
        chat_id: CHAT_ID,
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      ...overrides,
    },
  }
}

function assertRoute(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name)
  console.log(`ok - ${name}`)
}

async function testInboundRoutes(mapFeishuEventToInboundRoute: InboundMapper, OriginChannel: OriginChannelValues): Promise<void> {
  assertRoute("help command routes to help", mapFeishuEventToInboundRoute(imEvent("/help")), {
    kind: "help",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
  })

  assertRoute("hub command routes to current_hub", mapFeishuEventToInboundRoute(imEvent("/hub")), {
    kind: "hub_command",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
    command: "current_hub",
  })

  const hubId = "11111111-1111-4111-8111-111111111111"
  assertRoute("select-hub command captures hub id", mapFeishuEventToInboundRoute(imEvent(`/select-hub ${hubId}`)), {
    kind: "hub_command",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
    command: "select_hub",
    hubId,
  })

  assertRoute("add command routes to add_item", mapFeishuEventToInboundRoute(imEvent("/add 跟进客户风险")), {
    kind: "hub_command",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
    command: "execute",
    hubCommand: { command: "add_item", title: "跟进客户风险" },
  })

  assertRoute("list command routes to list_items", mapFeishuEventToInboundRoute(imEvent("/list")), {
    kind: "hub_command",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
    command: "execute",
    hubCommand: { command: "list_items" },
  })

  const ingestion = mapFeishuEventToInboundRoute(imEvent("这个任务负责人是 Alice，周五前跟进阻塞风险"))
  assert.equal(ingestion.kind, "source_ingestion", "keyword IM should route to source ingestion")
  if (ingestion.kind === "source_ingestion") {
    assert.equal(ingestion.payload.originChannel, OriginChannel.Im)
    assert.equal(ingestion.payload.contentText, "这个任务负责人是 Alice，周五前跟进阻塞风险")
    assert.equal(ingestion.payload.chatId, CHAT_ID)
    assert.equal(ingestion.payload.actorOpenId, ACTOR_OPEN_ID)
    assert.equal(ingestion.payload.projectToBase, true)
  }
  console.log("ok - keyword IM routes to source ingestion")

  const ignored = mapFeishuEventToInboundRoute(imEvent("大家早上好"))
  assert.equal(ignored.kind, "ignore")
  if (ignored.kind === "ignore") {
    assert.equal(ignored.reason, "im message did not match ingestion keywords")
  }
  console.log("ok - casual chat routes to ignore")

  const mentionEvent = imEvent("<at user_id=\"ou_bot\">机器人</at> 总结当前阻塞事项", {
    message: {
      message_id: "om_mention",
      chat_id: CHAT_ID,
      message_type: "text",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">机器人</at> 总结当前阻塞事项" }),
      mentions: [{ id: { open_id: "ou_bot" }, name: "机器人" }],
    },
  })
  assertRoute("@bot question routes to agent_question", mapFeishuEventToInboundRoute(mentionEvent), {
    kind: "agent_question",
    chatId: CHAT_ID,
    actorOpenId: ACTOR_OPEN_ID,
    question: "总结当前阻塞事项",
    messageId: "om_mention",
  })
}

async function testMessageBotTransport(message: MessageModule): Promise<void> {
  const calls: Array<{ args: string[]; stdin: string }> = []
  message.setMessageTransportForTest(async (args, stdin) => {
    calls.push({ args, stdin })
    return { data: { message_id: `msg_${calls.length}` } }
  })

  try {
    assert.equal(await message.sendTextToChat(CHAT_ID, "帮助文本"), "msg_1")
    assert.equal(await message.sendCardToChat(CHAT_ID, { type: "card", data: { title: "待办" } }), "msg_2")
  } finally {
    message.setMessageTransportForTest(null)
  }

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args.slice(0, 5), ["api", "POST", "/open-apis/im/v1/messages", "--as", "bot"])
  assert.deepEqual(calls[1].args.slice(0, 5), ["api", "POST", "/open-apis/im/v1/messages", "--as", "bot"])

  const textBody = JSON.parse(calls[0].stdin) as { receive_id: string; msg_type: string; content: string }
  assert.equal(textBody.receive_id, CHAT_ID)
  assert.equal(textBody.msg_type, "text")
  assert.deepEqual(JSON.parse(textBody.content) as unknown, { text: "帮助文本" })

  const cardBody = JSON.parse(calls[1].stdin) as { receive_id: string; msg_type: string; content: string }
  assert.equal(cardBody.receive_id, CHAT_ID)
  assert.equal(cardBody.msg_type, "interactive")
  assert.deepEqual(JSON.parse(cardBody.content) as unknown, { type: "card", data: { title: "待办" } })

  console.log("ok - outbound text and card use bot identity")
}

async function main(): Promise<void> {
  const [{ mapFeishuEventToInboundRoute }, { OriginChannel }, message] = await Promise.all([
    import("../src/trigger/feishu-ingestion-adapter.js"),
    import("../src/shared/types.js"),
    import("../src/integration/message.js"),
  ])

  await testInboundRoutes(mapFeishuEventToInboundRoute, OriginChannel)
  await testMessageBotTransport(message)
  console.log("IM inbound loopback tests passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
