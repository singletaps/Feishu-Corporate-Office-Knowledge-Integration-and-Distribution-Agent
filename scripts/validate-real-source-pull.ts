import { buildSourceIngestionPayloadFromPull } from "../src/application/feishu-source-pull-service.js"
import { OriginChannel } from "../src/shared/types.js"
import type { FeishuSourcePullRoute } from "../src/application/feishu-source-pull-service.js"

const channelArg = (process.argv[2] ?? process.env.FEISHU_SOURCE_PULL_CHANNEL ?? "doc").toLowerCase()
const target = process.env.FEISHU_SOURCE_PULL_TARGET ?? process.argv[3] ?? ""

async function main(): Promise<void> {
  if (channelArg !== "doc" && channelArg !== "wiki") {
    throw new Error("Usage: npm run validate:source-pull:real -- <doc|wiki> [token-or-url]")
  }
  if (!target) {
    throw new Error("Missing source target. Set FEISHU_SOURCE_PULL_TARGET or pass a token/URL argument.")
  }

  const route = buildRoute(channelArg, target)
  const payload = await buildSourceIngestionPayloadFromPull(route)
  const sourceHost = payload.sourceUrl ? safeHost(payload.sourceUrl) : null

  console.log(JSON.stringify({
    ok: true,
    originChannel: payload.originChannel,
    title: payload.title ?? null,
    contentLength: payload.contentText.length,
    hasOwnerUserId: Boolean(payload.ownerUserId),
    hasDocToken: Boolean(payload.docToken),
    hasWikiSpaceId: Boolean(payload.wikiSpaceId),
    sourceHost,
    projectToBase: payload.projectToBase,
  }, null, 2))
}

function buildRoute(channel: "doc" | "wiki", input: string): FeishuSourcePullRoute {
  const isUrl = /^https?:\/\//iu.test(input)
  const originChannel = channel === "doc" ? OriginChannel.Doc : OriginChannel.Wiki
  return {
    kind: "source_pull",
    eventType: `${channel}_manual_pull`,
    originChannel,
    originContextId: isUrl ? `manual:${channel}:url` : input,
    sourceUrl: isUrl ? input : undefined,
    docToken: channel === "doc" && !isUrl ? input : process.env.FEISHU_SOURCE_PULL_DOC_TOKEN,
    wikiToken: channel === "wiki" && !isUrl ? input : process.env.FEISHU_SOURCE_PULL_WIKI_TOKEN,
    wikiSpaceId: process.env.FEISHU_SOURCE_PULL_WIKI_SPACE_ID,
    folderToken: process.env.FEISHU_SOURCE_PULL_FOLDER_TOKEN,
    ownerUserId: process.env.FEISHU_SOURCE_PULL_OWNER_USER_ID,
  }
}

function safeHost(value: string): string | null {
  try {
    return new URL(value).host
  } catch {
    return null
  }
}

main().catch((error: unknown) => {
  const err = error instanceof Error ? error : new Error(String(error))
  console.error(err.message)
  process.exitCode = 1
})
