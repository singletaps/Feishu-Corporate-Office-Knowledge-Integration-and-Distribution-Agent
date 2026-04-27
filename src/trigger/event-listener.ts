import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { log } from "../evaluation/logger.js"
import { normalizeFeishuEvent } from "./normalizer.js"
import { dispatchToWorkflow } from "./dispatcher.js"

const LARK_CLI = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli"

export function startEventListener(): void {
  log.info("starting lark-event listener")

  const child = spawn(LARK_CLI, [
    "event", "+subscribe",
    "--as", "bot",
    "--compact",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  const rl = createInterface({ input: child.stdout })

  rl.on("line", async (line) => {
    if (!line.trim()) return

    log.debug("raw event line", { line: line.slice(0, 200) })

    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(line)
    } catch {
      log.warn("failed to parse event line", { line: line.slice(0, 100) })
      return
    }

    const event = normalizeFeishuEvent(raw)
    const result = await dispatchToWorkflow(event)

    if (result.dispatched) {
      log.info("event dispatched to workflow", { eventId: event.eventId, runId: result.runId })
    }
  })

  child.stderr.on("data", (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) log.debug("lark-event stderr", { msg: msg.slice(0, 200) })
  })

  child.on("exit", (code) => {
    log.warn("lark-event listener exited", { code })
    log.info("restarting event listener in 5 seconds")
    setTimeout(() => startEventListener(), 5000)
  })

  child.on("error", (err) => {
    log.error("lark-event listener error", { error: err.message })
  })
}
