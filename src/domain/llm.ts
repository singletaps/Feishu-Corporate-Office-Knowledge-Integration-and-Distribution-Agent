import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "../evaluation/logger.js"
import { LLMExtractionError } from "../shared/errors.js"
import { callAgent } from "./openclaw-client.js"
import type { ZodType } from "zod"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = resolve(__dirname, "prompts")

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface LLMResponse {
  choices: Array<{ message: { content: string } }>
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

export interface LLMCallResult<T> {
  data: T
  tokenUsage: { input: number; output: number }
}

function loadTemplate(name: string): string {
  const path = resolve(PROMPTS_DIR, `${name}.txt`)
  return readFileSync(path, "utf-8")
}

function renderTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = variables[key]
    if (value === undefined) return `{{${key}}}`
    return typeof value === "string" ? value : JSON.stringify(value)
  })
}

function parseTemplateMessages(rendered: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  const sections = rendered.split(/^(System|User|Assistant):\s*$/m)

  let currentRole: ChatMessage["role"] | null = null
  for (const section of sections) {
    const trimmed = section.trim()
    if (trimmed === "System") { currentRole = "system"; continue }
    if (trimmed === "User") { currentRole = "user"; continue }
    if (trimmed === "Assistant") { currentRole = "assistant"; continue }
    if (currentRole && trimmed) {
      messages.push({ role: currentRole, content: trimmed })
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: rendered })
  }

  return messages
}

async function rawChat(messages: ChatMessage[]): Promise<LLMResponse> {
  const agentResult = await callAgent(messages)
  return {
    choices: [{ message: { content: agentResult.content } }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

export async function callLLM<T>(
  templateName: string,
  variables: Record<string, unknown>,
  outputSchema: ZodType<T>,
): Promise<LLMCallResult<T>> {
  log.info("calling LLM", { templateName, variableKeys: Object.keys(variables) })

  const template = loadTemplate(templateName)
  const rendered = renderTemplate(template, variables)
  const messages = parseTemplateMessages(rendered)

  const response = await rawChat(messages)
  const content = response.choices[0]?.message?.content ?? ""
  const usage = response.usage

  log.debug("LLM raw response", { templateName, contentLength: content.length })

  let result = parseAndValidate(content, templateName, outputSchema)

  if (!result.success) {
    log.warn("LLM structured output invalid, retrying once", {
      templateName,
      errors: result.error,
    })

    const retryResponse = await rawChat(messages)
    const retryContent = retryResponse.choices[0]?.message?.content ?? ""
    const retryResult = parseAndValidate(retryContent, templateName, outputSchema)
    if (!retryResult.success) {
      throw new LLMExtractionError(templateName, `Structured output invalid after retry: ${retryResult.error}`)
    }

    return {
      data: retryResult.data,
      tokenUsage: {
        input: (usage?.prompt_tokens ?? 0) + (retryResponse.usage?.prompt_tokens ?? 0),
        output: (usage?.completion_tokens ?? 0) + (retryResponse.usage?.completion_tokens ?? 0),
      },
    }
  }

  log.info("LLM call success", {
    templateName,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
  })

  return {
    data: result.data,
    tokenUsage: {
      input: usage?.prompt_tokens ?? 0,
      output: usage?.completion_tokens ?? 0,
    },
  }
}

function parseAndValidate<T>(
  content: string,
  templateName: string,
  outputSchema: ZodType<T>,
): { success: true; data: T } | { success: false; error: string } {
  let parsed: unknown
  try {
    parsed = parseJsonResponse(content)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }

  const result = outputSchema.safeParse(parsed)
  if (!result.success) {
    return {
      success: false,
      error: result.error.issues.map((issue) => issue.message).join(", "),
    }
  }
  return { success: true, data: result.data }
}

function parseJsonResponse(content: string): unknown {
  const normalized = extractJsonPayload(content)
  try {
    return JSON.parse(normalized)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON response: ${message}`)
  }
}

function extractJsonPayload(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced?.[1]) return fenced[1].trim()

  const firstObject = trimmed.indexOf("{")
  const lastObject = trimmed.lastIndexOf("}")
  if (firstObject >= 0 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1)
  }

  return trimmed
}
