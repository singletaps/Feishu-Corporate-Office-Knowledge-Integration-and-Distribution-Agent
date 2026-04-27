import { config } from "../shared/config.js"

export function authorize(headers: Headers): boolean {
  const header = headers.get("authorization") ?? ""
  const expected = `Bearer ${config.agentTools.token}`
  return header === expected
}
