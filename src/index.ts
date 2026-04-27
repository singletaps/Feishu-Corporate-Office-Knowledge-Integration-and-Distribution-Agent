import { config } from "./shared/config.js"
import { db } from "./shared/db.js"
import { redis } from "./shared/redis.js"
import { log } from "./evaluation/logger.js"
import { startEventListener } from "./trigger/event-listener.js"
import { startAgentToolsServer } from "./agent-tools/server.js"

async function main() {
  log.info("feishu agent starting", { logLevel: config.logLevel })

  const dbResult = await db.query<{ now: Date }>("SELECT now()")
  log.info("database connected", { serverTime: dbResult[0]?.now })

  const redisResult = await redis.ping()
  log.info("redis connected", { ping: redisResult })

  log.info("all services healthy")

  startAgentToolsServer()
  startEventListener()

  log.info("feishu agent running — listening for events and agent tool calls")
}

main().catch((err) => {
  log.error("startup failed", { error: (err as Error).message, stack: (err as Error).stack })
  process.exit(1)
})
