import { execFile } from "node:child_process"
import { log } from "../evaluation/logger.js"
import { FeishuAPIError } from "../shared/errors.js"

export async function larkCli(args: string[]): Promise<unknown> {
  const fullArgs = [...args, "--format", "json"]
  log.info("lark-cli call", { args: fullArgs.join(" ") })

  return new Promise((resolve, reject) => {
    execFile("lark-cli", fullArgs, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        log.error("lark-cli failed", { args: fullArgs.join(" "), stderr, code: error.code })
        reject(new FeishuAPIError("lark-cli", fullArgs.join(" "), stderr || error.message))
        return
      }

      if (stderr) {
        log.warn("lark-cli stderr", { stderr: stderr.slice(0, 500) })
      }

      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve(null)
        return
      }

      const parsed = JSON.parse(trimmed)
      log.debug("lark-cli response", { args: fullArgs.join(" "), responseKeys: Object.keys(parsed) })
      resolve(parsed)
    })
  })
}

export async function larkCliRaw(args: string[]): Promise<string> {
  log.info("lark-cli raw call", { args: args.join(" ") })

  return new Promise((resolve, reject) => {
    execFile("lark-cli", args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        log.error("lark-cli raw failed", { args: args.join(" "), stderr })
        reject(new FeishuAPIError("lark-cli", args.join(" "), stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}
