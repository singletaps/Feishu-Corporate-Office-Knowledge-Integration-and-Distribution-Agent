import { config } from "../shared/config.js"

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type Level = keyof typeof LEVELS

const currentLevel: Level = config.logLevel

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel]
}

function emit(level: Level, msg: string, context?: Record<string, unknown>) {
  if (!shouldLog(level)) return
  const entry = { level, msg, ts: new Date().toISOString(), ...context }
  if (level === "error") {
    console.error(JSON.stringify(entry))
  } else {
    console.log(JSON.stringify(entry))
  }
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("error", msg, ctx),
}
