import { AppError } from "../shared/errors.js"
import { OriginChannel } from "../shared/types.js"

export interface FeishuDocumentPullRequest {
  originChannel: typeof OriginChannel.Doc | typeof OriginChannel.Wiki
  originContextId: string
  sourceUrl?: string
  docToken?: string
  wikiToken?: string
  wikiSpaceId?: string
  folderToken?: string
  ownerUserId?: string
}

export interface PulledFeishuDocument {
  title?: string
  contentText: string
  ownerUserId?: string
  sourceUrl?: string
  docToken?: string
  wikiSpaceId?: string
  folderToken?: string
}

export type LarkCliCaller = (args: string[]) => Promise<unknown>
export type FeishuDocumentPuller = (request: FeishuDocumentPullRequest) => Promise<PulledFeishuDocument>

export async function pullFeishuDocumentBody(
  request: FeishuDocumentPullRequest,
  cli?: LarkCliCaller,
): Promise<PulledFeishuDocument> {
  const docIdentifier = request.sourceUrl ?? request.docToken ?? request.wikiToken ?? request.originContextId
  if (!docIdentifier) {
    throw new AppError("document pull requires a doc/wiki token or source URL", "FEISHU_DOCUMENT_TOKEN_MISSING", {
      originChannel: request.originChannel,
      originContextId: request.originContextId,
    })
  }

  const caller = cli ?? (await import("./lark-cli.js")).larkCli
  const response = await caller([
    "docs",
    "+fetch",
    "--api-version",
    "v2",
    "--doc",
    docIdentifier,
  ])

  return normalizeDocumentResponse(response, request)
}

function normalizeDocumentResponse(response: unknown, request: FeishuDocumentPullRequest): PulledFeishuDocument {
  const contentText = firstStringAt(response, [
    ["data", "document", "content"],
    ["data", "document", "markdown"],
    ["data", "markdown"],
    ["data", "content"],
    ["document", "content"],
    ["document", "markdown"],
    ["markdown"],
    ["content"],
    ["text"],
  ]) || collectTextFragments(response).join("\n").trim()

  if (!contentText) {
    throw new AppError("document body fetch returned empty content", "FEISHU_DOCUMENT_BODY_EMPTY", {
      originChannel: request.originChannel,
      originContextId: request.originContextId,
    })
  }

  return {
    title: firstStringAt(response, [
      ["data", "document", "title"],
      ["data", "title"],
      ["document", "title"],
      ["title"],
      ["name"],
    ]) || undefined,
    contentText,
    ownerUserId: request.ownerUserId || firstStringAt(response, [
      ["data", "document", "owner_id"],
      ["data", "owner_id"],
      ["document", "owner_id"],
      ["owner_id"],
      ["owner", "open_id"],
      ["owner", "user_id"],
    ]) || undefined,
    sourceUrl: request.sourceUrl || firstStringAt(response, [
      ["data", "document", "url"],
      ["data", "url"],
      ["document", "url"],
      ["url"],
    ]) || undefined,
    docToken: request.docToken ?? (request.originChannel === OriginChannel.Doc ? request.originContextId : undefined),
    wikiSpaceId: request.wikiSpaceId,
    folderToken: request.folderToken,
  }
}

function firstStringAt(value: unknown, paths: string[][]): string {
  for (const path of paths) {
    const found = getPath(value, path)
    if (typeof found === "string" && found.trim()) return found.trim()
  }
  return ""
}

function getPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

function collectTextFragments(value: unknown): string[] {
  if (typeof value === "string") return []
  if (Array.isArray(value)) return value.flatMap(collectTextFragments)
  if (!value || typeof value !== "object") return []

  const obj = value as Record<string, unknown>
  const direct = ["plain_text", "text", "content", "markdown"]
    .flatMap((key) => typeof obj[key] === "string" ? [String(obj[key]).trim()] : [])
  const nested = ["fragments", "blocks", "children", "elements", "items"]
    .flatMap((key) => collectTextFragments(obj[key]))

  return [...direct, ...nested].filter(Boolean)
}
