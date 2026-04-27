import { resolve } from "node:path"
import "dotenv/config"

export interface AppConfig {
  database: { url: string }
  redis: { url: string }
  feishu: { appId: string; appSecret: string; baseToken: string; baseTableId: string; baseUrl: string }
  llm: { baseUrl: string; apiKey: string; model: string }
  openclaw: {
    baseUrl: string
    token: string
    model: string
    /** OpenClaw workspace agent id for Gateway `agent` (e.g. main). */
    agentId: string
    /** ws:// or wss:// Gateway; derived from baseUrl if unset. */
    wsUrl: string
    deviceIdentityPath: string
    deviceTokenPath: string
  }
  agentTools: { port: number; token: string }
  notifications: { defaultChatId: string | null }
  logLevel: "debug" | "info" | "warn" | "error"
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
}

function envWithDefault(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue
}

/** Optional: only needed if you use direct-LLM calls outside OpenClaw. */
function optionalLlmApiKey(): string {
  return process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ""
}

function defaultOpenClawWsUrl(): string {
  const b = process.env.OPENCLAW_BASE_URL ?? "http://127.0.0.1:18789"
  try {
    const u = new URL(b)
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
    return u.origin
  } catch {
    return "ws://127.0.0.1:18789"
  }
}

export const config: AppConfig = {
  database: {
    url: requireEnv("DATABASE_URL"),
  },
  redis: {
    url: requireEnv("REDIS_URL"),
  },
  feishu: {
    appId: requireEnv("FEISHU_APP_ID"),
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    baseToken: requireEnv("FEISHU_BASE_TOKEN"),
    baseTableId: requireEnv("FEISHU_BASE_TABLE_ID"),
    baseUrl: requireEnv("FEISHU_BASE_URL"),
  },
  /** Direct API (e.g. DeepSeek) — optional; main LLM path is OpenClaw Gateway. */
  llm: {
    baseUrl: envWithDefault("LLM_BASE_URL", "https://api.deepseek.com"),
    apiKey: optionalLlmApiKey(),
    model: envWithDefault("LLM_MODEL", "deepseek-v4-flash"),
  },
  openclaw: {
    baseUrl: process.env.OPENCLAW_BASE_URL ?? "http://127.0.0.1:18789",
    token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "",
    /** OpenClaw model ref (documentation); WS `agent` uses workspace default unless overridden in Gateway. */
    model: envWithDefault("OPENCLAW_MODEL", "deepseek/deepseek-v4-flash"),
    agentId: envWithDefault("OPENCLAW_AGENT_ID", "main"),
    wsUrl: envWithDefault("OPENCLAW_WS_URL", defaultOpenClawWsUrl()),
    deviceIdentityPath: envWithDefault(
      "OPENCLAW_DEVICE_IDENTITY_PATH",
      resolve(process.cwd(), ".data", "openclaw-device-identity.json"),
    ),
    deviceTokenPath: envWithDefault(
      "OPENCLAW_DEVICE_TOKEN_PATH",
      resolve(process.cwd(), ".data", "openclaw-device-token.json"),
    ),
  },
  agentTools: {
    port: Number(process.env.AGENT_TOOLS_PORT ?? "8787"),
    token: process.env.AGENT_TOOLS_TOKEN ?? "dev-agent-tools-token",
  },
  notifications: {
    defaultChatId: process.env.FEISHU_DEFAULT_CHAT_ID ?? null,
  },
  logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
}
