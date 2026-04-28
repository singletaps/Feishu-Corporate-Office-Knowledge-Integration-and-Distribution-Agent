import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { log } from "../evaluation/logger.js"
import { normalizeFeishuEvent } from "./normalizer.js"
import { dispatchToWorkflow } from "./dispatcher.js"

const LARK_CLI = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli"
let activeListenerPid: number | null = null
let shuttingDown = false

export function startEventListener(): void {
  log.info("starting lark-event listener")

  const child = spawn(LARK_CLI, [
    "event", "+subscribe",
    "--event-types", "im.message.receive_v1,card.action.trigger",
    "--as", "bot",
    "--compact",
    "--quiet",
  ], {
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  activeListenerPid = child.pid ?? null
  installShutdownCleanup()

  const rl = createInterface({ input: child.stdout })

  rl.on("line", async (line) => {
    if (!line.trim()) return

    log.info("raw lark event received", { line: line.slice(0, 500) })

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      log.warn("failed to parse event line", { line: line.slice(0, 100) })
      return
    }

    const event = normalizeFeishuEvent(raw)
    try {
      const result = await dispatchToWorkflow(event)

      if (result.dispatched) {
        log.info("event dispatched to workflow", { eventId: event.eventId, runId: result.runId })
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      log.error("event dispatch failed", {
        eventId: event.eventId,
        eventType: event.eventType,
        error: err.message,
        stack: err.stack,
      })
    }
  })

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) log.warn("lark-event stderr", { msg: msg.slice(0, 1000) })
  })

  child.on("exit", (code) => {
    if (activeListenerPid === child.pid) activeListenerPid = null
    log.warn("lark-event listener exited", { code })
    if (shuttingDown) return
    log.info("restarting event listener in 5 seconds")
    setTimeout(() => startEventListener(), 5000)
  })

  child.on("error", (err) => {
    log.error("lark-event listener error", { error: err.message })
  })
}

let cleanupInstalled = false

function installShutdownCleanup(): void {
  if (cleanupInstalled) return
  cleanupInstalled = true

  const cleanup = () => {
    shuttingDown = true
    stopActiveListener()
  }

  process.once("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    cleanup()
    process.exit(143)
  })
  process.once("exit", cleanup)
}

function stopActiveListener(): void {
  if (!activeListenerPid) return

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(activeListenerPid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
  } else {
    try {
      process.kill(-activeListenerPid, "SIGTERM")
    } catch {
      try {
        process.kill(activeListenerPid, "SIGTERM")
      } catch {
        // Best-effort cleanup during process shutdown.
      }
    }
  }
  activeListenerPid = null
}
