/**
 * OpenClaw Gateway WebSocket client with Ed25519 device auth + deviceToken persistence.
 * Signed payload: v2 or v3 (default v3) per OpenClaw `src/gateway/device-auth.ts`.
 */
import { randomUUID } from "node:crypto"
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import WebSocket from "ws"
import { buildDeviceAuthPayloadV2, buildDeviceAuthPayloadV3 } from "./openclaw-device-auth-payload.js"
import { loadOrCreateDeviceIdentity, signDevicePayloadUtf8, type DeviceIdentity } from "./openclaw-device-identity.js"
import { log } from "../evaluation/logger.js"

const DEFAULT_SCOPES = ["operator.read", "operator.write"] as const
const CHALLENGE_MS = 20_000
const RPC_MS = 120_000
/** `agent` first responds with `accepted`, then with `ok`+`result` or `error`. */
function isOpenClawAgentTerminalPayload(p: unknown): boolean {
  if (p == null || typeof p !== "object") return false
  const o = p as Record<string, unknown>
  if (o.status === "accepted") return false
  if (o.status === "error") return true
  if (o.status === "ok" && o.result !== undefined) return true
  return false
}

/** Thrown when the Gateway accepts the device signature but the device is not yet approved. */
export class OpenClawGatewayPairingRequiredError extends Error {
  readonly code = "PAIRING_REQUIRED" as const
  constructor(
    message: string,
    readonly requestId: string,
    readonly deviceId: string,
    readonly details: unknown,
  ) {
    super(message)
    this.name = "OpenClawGatewayPairingRequiredError"
  }
}

export type GatewayFrame =
  | { type: "req"; id: string; method: string; params?: Record<string, unknown> }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown }
  | { type: "event"; event: string; payload?: unknown; seq?: number }

export type OpenClawGatewayWsOptions = {
  wsUrl: string
  gatewayToken: string
  deviceIdentityPath: string
  deviceTokenPath: string
  /** v3 appends `platform|deviceFamily` to the signed string (see OpenClaw device-auth). Default false for max Gateway compatibility. */
  useAuthV3?: boolean
  platform?: string
  deviceFamily?: string
  minProtocol?: number
  maxProtocol?: number
  /**
   * Must match Gateway allowlist; official CLI often uses `cli` for both `client.id` and `client.mode`.
   * The signed v2/v3 `clientId` / `clientMode` fields must match `params.client.id` and `params.client.mode`.
   */
  clientId?: string
  clientMode?: string
  userAgent?: string
}

type PendingOne = {
  kind: "one"
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  clearTimer: () => void
}

type PendingMulti = {
  kind: "multi"
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  clearTimer: () => void
  isFinal: (payload: unknown) => boolean
}

type PendingEntry = PendingOne | PendingMulti

export class OpenClawGatewayWsClient {
  private ws: WebSocket | null = null
  private readonly pending = new Map<string, PendingEntry>()

  constructor(private readonly opts: OpenClawGatewayWsOptions) {}

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  async connect(): Promise<{ hello: unknown; deviceToken?: string }> {
    const identity = await loadOrCreateDeviceIdentity(this.opts.deviceIdentityPath)
    const stored = this.readDeviceToken()
    const bootstrap = this.opts.gatewayToken
    let authToken = stored ?? bootstrap

    const run = async (token: string) => {
      this.close()
      return this.performHandshake(identity, token)
    }

    try {
      return await run(authToken)
    } catch (err) {
      const msg = String((err as Error).message ?? err)
      if (authToken !== bootstrap && (msg.includes("mismatch") || msg.toLowerCase().includes("unauthorized"))) {
        log.warn("OpenClaw WS: device token retry with gateway bootstrap token", { err: msg })
        this.clearDeviceToken()
        return await run(bootstrap)
      }
      throw err
    }
  }

  private readDeviceToken(): string | undefined {
    const p = this.opts.deviceTokenPath
    if (!existsSync(p)) return undefined
    try {
      const j = JSON.parse(readFileSync(p, "utf8").replace(/^\uFEFF/, "")) as { deviceToken?: string }
      return typeof j.deviceToken === "string" && j.deviceToken.length > 0 ? j.deviceToken : undefined
    } catch {
      return undefined
    }
  }

  private clearDeviceToken(): void {
    try {
      if (existsSync(this.opts.deviceTokenPath)) {
        writeFileSync(this.opts.deviceTokenPath, "{}", "utf8")
      }
    } catch {
      /* ignore */
    }
  }

  private writeDeviceToken(deviceToken: string): void {
    const p = this.opts.deviceTokenPath
    const dir = dirname(p)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(p, JSON.stringify({ deviceToken, updatedAtMs: Date.now() }, null, 2), "utf8")
  }

  private dispatchFrame(raw: string): void {
    let frame: GatewayFrame
    try {
      frame = JSON.parse(raw) as GatewayFrame
    } catch {
      return
    }
    if (frame.type === "res" && "id" in frame && this.pending.has(frame.id)) {
      const entry = this.pending.get(frame.id) as PendingEntry
      if (entry.kind === "multi") {
        if (!frame.ok) {
          entry.clearTimer()
          this.pending.delete(frame.id)
          this.rejectGatewayRes(entry.reject, frame)
        } else if (entry.isFinal(frame.payload)) {
          entry.clearTimer()
          this.pending.delete(frame.id)
          entry.resolve(frame.payload)
        }
        return
      }
      const one = entry as PendingOne
      one.clearTimer()
      this.pending.delete(frame.id)
      if (frame.ok) {
        one.resolve(frame.payload)
      } else {
        this.rejectGatewayRes(one.reject, frame)
      }
    }
  }

  private rejectGatewayRes(
    reject: (e: Error) => void,
    frame: GatewayFrame & { id: string; ok: boolean },
  ): void {
    const errBody = (frame as {
      error?: { code?: string; message?: string; details?: { requestId?: string; deviceId?: string } }
    }).error
    const code = errBody?.code ?? errBody?.message
    const d = errBody?.details
    if (d?.requestId && (String(code) === "NOT_PAIRED" || errBody?.message?.includes("pairing"))) {
      reject(
        new OpenClawGatewayPairingRequiredError(
          errBody?.message ?? "pairing required",
          String(d.requestId),
          String(d.deviceId ?? ""),
          errBody,
        ),
      )
    } else {
      reject(new Error(`Gateway: ${JSON.stringify((frame as { error?: unknown }).error ?? frame)}`))
    }
  }

  private onRawMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
    if (isBinary) return
    this.dispatchFrame(data.toString())
  }

  private waitPayload(id: string, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Gateway RPC timeout: ${id}`))
      }, ms)
      const clearTimer = () => {
        clearTimeout(t)
      }
      this.pending.set(id, {
        kind: "one",
        resolve: (v) => {
          clearTimer()
          resolve(v)
        },
        reject: (e) => {
          clearTimer()
          reject(e)
        },
        clearTimer,
      })
    })
  }

  /**
   * Gateway `agent` sends two `res` frames with the same `id` (accepted, then completed). Wait until final payload.
   * @see openclaw src/gateway/server-methods/agent.ts
   */
  private waitAgentFinalPayload(id: string, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Gateway agent timeout: ${id}`))
      }, ms)
      const clearTimer = () => {
        clearTimeout(t)
      }
      this.pending.set(id, {
        kind: "multi",
        resolve: (v) => {
          clearTimer()
          resolve(v)
        },
        reject: (e) => {
          clearTimer()
          reject(e)
        },
        clearTimer,
        isFinal: isOpenClawAgentTerminalPayload,
      })
    })
  }

  private async readConnectChallenge(ws: WebSocket): Promise<{ nonce: string; ts?: number }> {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        cleanup()
        reject(new Error("connect.challenge not received in time (check Gateway is ws(s) to port and URL)"))
      }, CHALLENGE_MS)

      const onMsg = (data: WebSocket.RawData, isBinary: boolean): void => {
        if (isBinary) return
        const text = data.toString()
        let frame: GatewayFrame
        try {
          frame = JSON.parse(text) as GatewayFrame
        } catch {
          return
        }
        if (frame.type === "event" && frame.event === "connect.challenge") {
          const pl = (frame.payload ?? {}) as { nonce?: string; ts?: number }
          clearTimeout(to)
          cleanup()
          resolve({ nonce: pl.nonce != null ? String(pl.nonce) : "", ts: pl.ts })
        } else {
          this.dispatchFrame(text)
        }
      }

      const cleanup = () => {
        ws.off("message", onMsg)
      }

      ws.on("message", onMsg)
    })
  }

  private async performHandshake(identity: DeviceIdentity, authToken: string): Promise<{
    hello: unknown
    deviceToken?: string
  }> {
    return new Promise((resolve, reject) => {
      const url = this.opts.wsUrl
      const ws = new WebSocket(url, { perMessageDeflate: false })
      this.ws = ws

      const fail = (e: Error) => {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        this.ws = null
        reject(e)
      }

      void (async () => {
        try {
          await new Promise<void>((res, rej) => {
            ws.once("open", () => res())
            ws.once("error", (e) => rej(e instanceof Error ? e : new Error(String(e))))
          })

          const challenge = await this.readConnectChallenge(ws)
          ws.on("message", this.onRawMessage)

          const useV3 = this.opts.useAuthV3 === true
          const clientId = this.opts.clientId ?? "cli"
          const clientMode = this.opts.clientMode ?? "cli"
          const platform = this.opts.platform ?? process.platform
          const deviceFamily = this.opts.deviceFamily ?? "feishuagent"
          const minP = this.opts.minProtocol ?? 3
          const maxP = this.opts.maxProtocol ?? 4
          const signedAt = Date.now()
          const nonce = challenge.nonce

          const common = {
            deviceId: identity.deviceId,
            clientId,
            clientMode,
            role: "operator" as const,
            scopes: [...DEFAULT_SCOPES],
            signedAtMs: signedAt,
            token: authToken,
            nonce,
          }

          const payloadStr = useV3
            ? buildDeviceAuthPayloadV3({ ...common, platform, deviceFamily })
            : buildDeviceAuthPayloadV2(common)

          const signature = await signDevicePayloadUtf8(payloadStr, identity.privateKey)
          const connectId = randomUUID()
          const helloP = this.waitPayload(connectId, RPC_MS)

          const connectFrame: GatewayFrame = {
            type: "req",
            id: connectId,
            method: "connect",
            params: {
              minProtocol: minP,
              maxProtocol: maxP,
              client: {
                id: clientId,
                version: "1.0.0",
                platform,
                mode: clientMode,
              },
              role: "operator",
              scopes: [...DEFAULT_SCOPES],
              caps: [] as string[],
              commands: [] as string[],
              permissions: {} as Record<string, boolean>,
              auth: { token: authToken },
              locale: "en-US",
              userAgent: this.opts.userAgent ?? "feishuagent-openclaw-gateway-ws/1.0.0",
              device: {
                id: identity.deviceId,
                publicKey: identity.publicKey,
                signature,
                signedAt,
                nonce,
              },
            },
          }

          ws.send(JSON.stringify(connectFrame))
          const helloPayload = await helloP
          const auth = (helloPayload as { auth?: { deviceToken?: string } } | null)?.auth
          const deviceToken =
            auth && typeof auth.deviceToken === "string" ? auth.deviceToken : undefined
          if (deviceToken) {
            this.writeDeviceToken(deviceToken)
          }
          resolve({ hello: helloPayload, deviceToken })
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)))
        }
      })()
    })
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.isConnected()) {
      throw new Error("OpenClaw WebSocket is not open (connect() first)")
    }
    const id = randomUUID()
    const p = this.waitPayload(id, RPC_MS) as Promise<T>
    const frame: GatewayFrame = { type: "req", id, method, params }
    this.ws!.send(JSON.stringify(frame))
    return p
  }

  /**
   * Run OpenClaw Gateway `agent` (async job with two res frames: accepted → result).
   */
  async requestAgent(params: {
    message: string
    idempotencyKey: string
    agentId?: string
    sessionKey?: string
  }): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error("OpenClaw WebSocket is not open (connect() first)")
    }
    const id = randomUUID()
    const p = this.waitAgentFinalPayload(id, RPC_MS * 2)
    const body: Record<string, unknown> = {
      message: params.message,
      idempotencyKey: params.idempotencyKey,
      deliver: false,
    }
    if (params.agentId) body.agentId = params.agentId
    if (params.sessionKey) body.sessionKey = params.sessionKey
    const frame: GatewayFrame = { type: "req", id, method: "agent", params: body }
    this.ws!.send(JSON.stringify(frame))
    return p
  }

  close(): void {
    for (const [, entry] of this.pending) {
      entry.clearTimer()
      entry.reject(new Error("Client closed"))
    }
    this.pending.clear()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
  }
}

/**
 * Parse the final `agent` res `payload` (expects `status` + `result` or terminal `error`).
 */
export function extractOpenClawAgentReplyText(payload: unknown): string {
  if (payload == null || typeof payload !== "object") {
    return ""
  }
  const p = payload as Record<string, unknown>
  if (p.status === "error") {
    const summary = p.summary ?? p.error ?? "unknown agent error"
    throw new Error(`OpenClaw agent run failed: ${String(summary)}`)
  }
  if (p.status !== "ok" || p.result === undefined) {
    throw new Error(`OpenClaw agent: unexpected payload: ${JSON.stringify(payload).slice(0, 500)}`)
  }
  return extractOpenClawAgentResultBody(p.result)
}

function extractOpenClawAgentResultBody(result: unknown): string {
  if (result == null) {
    return ""
  }
  if (typeof result === "string") {
    return result
  }
  if (typeof result !== "object") {
    return String(result)
  }
  const r = result as Record<string, unknown>
  if (typeof r.text === "string") {
    return r.text
  }
  if (typeof r.content === "string") {
    return r.content
  }
  if (typeof r.message === "string") {
    return r.message
  }
  if (Array.isArray(r.payloads)) {
    const text = r.payloads
      .map((payload) => {
        if (!payload || typeof payload !== "object") return ""
        const p = payload as Record<string, unknown>
        return typeof p.text === "string" ? p.text : ""
      })
      .filter(Boolean)
      .join("\n")
    if (text) return text
  }
  const meta = r.meta
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>
    if (typeof m.finalAssistantVisibleText === "string") return m.finalAssistantVisibleText
    if (typeof m.finalAssistantRawText === "string") return m.finalAssistantRawText
  }
  if (Array.isArray(r.messages)) {
    const assist = [...r.messages]
      .reverse()
      .find((m) => m && typeof m === "object" && (m as { role?: string }).role === "assistant") as
      | { content?: string }
      | undefined
    if (assist && typeof assist.content === "string") {
      return assist.content
    }
  }
  log.warn("OpenClaw agent result shape not recognized, using JSON string", { keys: Object.keys(r) })
  return JSON.stringify(result)
}

export function openClawHttpToWsBase(httpBase: string): string {
  const u = new URL(httpBase)
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
  return u.origin
}

export async function probeOpenClawGatewayOperator(o: OpenClawGatewayWsOptions): Promise<{
  agents: unknown
  tools: unknown
  hello: unknown
  deviceToken?: string
}> {
  const c = new OpenClawGatewayWsClient(o)
  const { hello, deviceToken } = await c.connect()
  const agents = await c.request("agents.list", {})
  let tools: unknown
  try {
    tools = await c.request("tools.catalog", { agentId: "main" })
  } catch (e) {
    log.debug("tools.catalog(agentId) fallback", { err: (e as Error).message })
    tools = await c.request("tools.catalog", {})
  }
  c.close()
  return { agents, tools, hello, deviceToken }
}
