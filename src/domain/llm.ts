import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../shared/config.js"
import { log } from "../evaluation/logger.js"
import { LLMExtractionError } from "../shared/errors.js"
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
  const body = JSON.stringify({
    model: config.llm.model,
    messages,
    temperature: 0.1,
    max_tokens: 4096,
    response_format: { type: "json_object" },
  })

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new LLMExtractionError("raw", `HTTP ${response.status}: ${text.slice(0, 200)}`)
  }

  return response.json() as Promise<LLMResponse>
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

  const parsed = JSON.parse(content)
  const result = outputSchema.safeParse(parsed)

  if (!result.success) {
    log.warn("schema validation failed, retrying once", {
      templateName,
      errors: result.error.issues.map((i) => i.message),
    })

    const retryResponse = await rawChat(messages)
    const retryContent = retryResponse.choices[0]?.message?.content ?? ""
    const retryParsed = JSON.parse(retryContent)

    const retryResult = outputSchema.safeParse(retryParsed)
    if (!retryResult.success) {
      throw new LLMExtractionError(templateName, `Schema validation failed after retry: ${retryResult.error.issues.map((i) => i.message).join(", ")}`)
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
