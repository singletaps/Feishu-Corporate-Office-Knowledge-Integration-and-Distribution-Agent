import "dotenv/config"

export interface AppConfig {
  database: { url: string }
  redis: { url: string }
  feishu: { appId: string; appSecret: string }
  llm: { baseUrl: string; apiKey: string; model: string }
  logLevel: "debug" | "info" | "warn" | "error"
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env: ${name}`)
  return value
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
  },
  llm: {
    baseUrl: requireEnv("LLM_BASE_URL"),
    apiKey: requireEnv("LLM_API_KEY"),
    model: process.env.LLM_MODEL ?? "deepseek-chat",
  },
  logLevel: (process.env.LOG_LEVEL as AppConfig["logLevel"]) ?? "info",
}
