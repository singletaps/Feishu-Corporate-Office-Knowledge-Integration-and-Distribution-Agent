import type { ItemStatus } from "../shared/types.js"

export function mapFeishuTaskStatus(externalStatus: string, current: ItemStatus): ItemStatus | null {
  const normalized = externalStatus.trim().toLowerCase().replace(/[\s-]+/gu, "_")
  if (["done", "completed", "complete", "finished"].includes(normalized)) return "done"
  if (["deleted", "closed", "cancelled", "canceled", "archived"].includes(normalized)) return "closed"
  if (["todo", "open", "pending", "in_progress", "doing", "active"].includes(normalized)) return "active"
  return current === "done" || current === "closed" ? current : null
}
