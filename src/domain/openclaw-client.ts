import { randomUUID } from "node:crypto"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import {
  OpenClawGatewayWsClient,
  extractOpenClawAgentReplyText,
  type OpenClawGatewayWsOptions,
} from "./openclaw-gateway-ws.js"

export interface AgentMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface AgentCallResult {
  content: string
  provider: "openclaw-gateway-agent"
}

function buildWsOptions(): OpenClawGatewayWsOptions {
  return {
    wsUrl: config.openclaw.wsUrl,
    gatewayToken: config.openclaw.token,
    deviceIdentityPath: config.openclaw.deviceIdentityPath,
    deviceTokenPath: config.openclaw.deviceTokenPath,
  }
}

function serializeMessagesForAgent(messages: AgentMessage[]): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n")
}

let sharedClient: OpenClawGatewayWsClient | null = null
let sharedConnect: Promise<OpenClawGatewayWsClient> | null = null

async function getConnectedGatewayClient(): Promise<OpenClawGatewayWsClient> {
  if (sharedClient?.isConnected()) {
    return sharedClient
  }
  if (sharedConnect) {
    return sharedConnect
  }
  sharedConnect = (async () => {
    const c = new OpenClawGatewayWsClient(buildWsOptions())
    await c.connect()
    sharedClient = c
    return c
  })()
  try {
    return await sharedConnect
  } finally {
    sharedConnect = null
  }
}

function invalidateGatewayClient(): void {
  try {
    sharedClient?.close()
  } catch {
    /* ignore */
  }
  sharedClient = null
}

/**
 * Calls the OpenClaw Gateway **only** via WebSocket + device auth (Path B) and the `agent` RPC.
 * No HTTP `/v1/*` and no direct DeepSeek fallback.
 */
export async function callAgent(messages: AgentMessage[]): Promise<AgentCallResult> {
  if (!config.openclaw.token?.trim()) {
    throw new Error(
      "OPENCLAW_GATEWAY_TOKEN is required: set it to your Gateway shared token (gateway.auth.token).",
    )
  }

  const message = serializeMessagesForAgent(messages)
  const idempotencyKey = randomUUID()

  try {
    const client = await getConnectedGatewayClient()
    const payload = await client.requestAgent({
      message,
      idempotencyKey,
      agentId: config.openclaw.agentId,
      sessionKey: process.env.OPENCLAW_SESSION_KEY?.trim() || undefined,
    })
    const content = extractOpenClawAgentReplyText(payload)
    return { content, provider: "openclaw-gateway-agent" }
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    log.warn("OpenClaw Gateway agent call failed, invalidating WS session", { err: msg })
    invalidateGatewayClient()
    throw err instanceof Error ? err : new Error(String(err))
  }
}
