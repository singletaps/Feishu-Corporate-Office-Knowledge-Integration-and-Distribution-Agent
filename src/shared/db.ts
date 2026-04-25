import pg from "pg"
import { config } from "./config.js"
import { log } from "../evaluation/logger.js"

const pool = new pg.Pool({ connectionString: config.database.url })

pool.on("error", (err) => {
  log.error("unexpected pg pool error", { error: err.message })
})

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function mapKeys(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    result[snakeToCamel(key)] = value
  }
  return result
}

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  log.debug("db query", { sql: sql.slice(0, 120), paramCount: params?.length ?? 0 })
  const result = await pool.query(sql, params)
  return result.rows.map((row) => mapKeys(row) as T)
}

export async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

export async function execute(sql: string, params?: unknown[]): Promise<number> {
  log.debug("db execute", { sql: sql.slice(0, 120), paramCount: params?.length ?? 0 })
  const result = await pool.query(sql, params)
  return result.rowCount ?? 0
}

export async function shutdown() {
  await pool.end()
}

export const db = { query, queryOne, execute, shutdown }
