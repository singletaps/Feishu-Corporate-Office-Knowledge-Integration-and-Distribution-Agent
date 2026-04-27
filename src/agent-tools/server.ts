import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import { AppError } from "../shared/errors.js"
import { authorize } from "./auth.js"
import { handleToolRequest } from "./routes.js"
import { handleCardCallback, type CardCallbackPayload } from "../application/card-callback-service.js"

export function startAgentToolsServer(): void {
  const server = createServer(async (req, res) => {
    await handleRequest(req, res)
  })

  server.listen(config.agentTools.port, () => {
    log.info("agent tools server listening", { port: config.agentTools.port })
  })
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "agent-tools" })
    return
  }

  if (req.method === "POST" && url.pathname.startsWith("/callback/card")) {
    await handleCardCallbackRequest(req, res)
    return
  }

  if (req.method !== "POST" || !url.pathname.startsWith("/tools/")) {
    sendJson(res, 404, { ok: false, error: "not found" })
    return
  }

  if (!authorize(new Headers(req.headers as Record<string, string>))) {
    sendJson(res, 401, { ok: false, error: "unauthorized" })
    return
  }

  try {
    const body = await readJson(req)
    log.info("agent tool request", { path: url.pathname })
    const result = await handleToolRequest(url.pathname, body)
    sendJson(res, 200, result)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error("agent tool request failed", { path: url.pathname, error: err.message, stack: err.stack })

    if (error instanceof AppError) {
      sendJson(res, 400, { ok: false, code: error.code, error: error.message, context: error.context })
      return
    }

    if (err.name === "ZodError") {
      sendJson(res, 400, { ok: false, code: "INVALID_TOOL_INPUT", error: err.message })
      return
    }

    sendJson(res, 500, { ok: false, code: "TOOL_REQUEST_FAILED", error: err.message })
  }
}

async function handleCardCallbackRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJson(req) as CardCallbackPayload & { token?: string }
    const headers = new Headers(req.headers as Record<string, string>)
    const tokenAuthorized = body.token && body.token === config.agentTools.token

    if (!authorize(headers) && !tokenAuthorized) {
      sendJson(res, 401, { ok: false, error: "unauthorized" })
      return
    }

    const result = await handleCardCallback(body)
    sendJson(res, 200, result)
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    log.error("card callback failed", { error: err.message, stack: err.stack })

    if (error instanceof AppError) {
      sendJson(res, 400, { ok: false, code: error.code, error: error.message, context: error.context })
      return
    }

    sendJson(res, 500, { ok: false, code: "CARD_CALLBACK_FAILED", error: err.message })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => { body += chunk })
    req.on("end", () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

const isDirectRun = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isDirectRun) {
  startAgentToolsServer()
}
