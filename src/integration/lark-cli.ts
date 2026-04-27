import { execFile, spawn } from "node:child_process"
import { log } from "../evaluation/logger.js"
import { FeishuAPIError } from "../shared/errors.js"

const LARK_CLI = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli"
const EXEC_OPTIONS = { maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" }

function normalizeArgs(args: string[]): string[] {
  if (process.platform !== "win32") return args
  return args.map((arg) => {
    if (!/[\s"]/u.test(arg)) return arg
    return `"${arg.replace(/"/g, '\\"')}"`
  })
}

export async function larkCli(args: string[]): Promise<unknown> {
  log.info("lark-cli call", { args: redactArgs(args).join(" ") })

  return new Promise((resolve, reject) => {
    execFile(LARK_CLI, normalizeArgs(args), EXEC_OPTIONS, (error, stdout, stderr) => {
      if (error) {
        log.error("lark-cli failed", { args: redactArgs(args).join(" "), stderr, code: error.code })
        reject(new FeishuAPIError("lark-cli", redactArgs(args).join(" "), stderr || error.message))
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
      log.debug("lark-cli response", { args: redactArgs(args).join(" "), responseKeys: Object.keys(parsed) })
      resolve(parsed)
    })
  })
}

export async function larkCliRaw(args: string[]): Promise<string> {
  log.info("lark-cli raw call", { args: redactArgs(args).join(" ") })

  return new Promise((resolve, reject) => {
    execFile(LARK_CLI, normalizeArgs(args), EXEC_OPTIONS, (error, stdout, stderr) => {
      if (error) {
        log.error("lark-cli raw failed", { args: redactArgs(args).join(" "), stderr })
        reject(new FeishuAPIError("lark-cli", redactArgs(args).join(" "), stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

export async function larkCliStdin(args: string[], stdin: string): Promise<unknown> {
  log.info("lark-cli stdin call", { args: redactArgs(args).join(" "), stdinLength: stdin.length })

  return new Promise((resolve, reject) => {
    const child = spawn(LARK_CLI, normalizeArgs(args), {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString() })
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString() })
    child.on("error", (error) => {
      reject(new FeishuAPIError("lark-cli", redactArgs(args).join(" "), error.message))
    })
    child.on("close", (code) => {
      if (code !== 0) {
        log.error("lark-cli stdin failed", { args: redactArgs(args).join(" "), stderr, code })
        reject(new FeishuAPIError("lark-cli", redactArgs(args).join(" "), stderr || `exit code ${code}`))
        return
      }

      if (stderr) {
        log.warn("lark-cli stdin stderr", { stderr: stderr.slice(0, 500) })
      }

      const trimmed = stdout.trim()
      resolve(trimmed ? JSON.parse(trimmed) : null)
    })

    child.stdin.end(stdin)
  })
}

function redactArgs(args: string[]): string[] {
  const sensitiveFlags = new Set([
    "--base-token",
    "--app-token",
    "--tenant-access-token",
    "--user-access-token",
    "--token",
  ])
  return args.map((arg, index) => {
    const previous = args[index - 1]
    if (previous && sensitiveFlags.has(previous)) return "<redacted>"
    return arg
  })
}
