import { Redis } from "ioredis"
import { config } from "./config.js"
import { log } from "../evaluation/logger.js"

export const redis = new Redis(config.redis.url)

redis.on("error", (err: Error) => {
  log.error("redis connection error", { error: err.message })
})

redis.on("connect", () => {
  log.info("redis connected")
})
