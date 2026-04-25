export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AppError"
  }
}

export class LLMExtractionError extends AppError {
  constructor(templateName: string, reason: string) {
    super(`LLM extraction failed: ${reason}`, "LLM_EXTRACTION_FAILED", { templateName, reason })
    this.name = "LLMExtractionError"
  }
}

export class FeishuAPIError extends AppError {
  constructor(service: string, method: string, detail: string) {
    super(`Feishu API error: ${service}.${method} — ${detail}`, "FEISHU_API_ERROR", { service, method, detail })
    this.name = "FeishuAPIError"
  }
}

export class ItemNotFoundError extends AppError {
  constructor(workItemId: string) {
    super(`WorkItem not found: ${workItemId}`, "ITEM_NOT_FOUND", { workItemId })
    this.name = "ItemNotFoundError"
  }
}
