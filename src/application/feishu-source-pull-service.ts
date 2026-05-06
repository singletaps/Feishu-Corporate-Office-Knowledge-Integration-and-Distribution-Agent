import {
  pullFeishuDocumentBody,
  type FeishuDocumentPuller,
} from "../integration/document.js"
import type {
  FeishuInboundRoute,
  SourceIngestionPayload,
} from "../trigger/feishu-ingestion-adapter.js"

export type FeishuSourcePullRoute = Extract<FeishuInboundRoute, { kind: "source_pull" }>

export interface BuildSourceIngestionPayloadDeps {
  pullDocumentBody?: FeishuDocumentPuller
}

export async function buildSourceIngestionPayloadFromPull(
  route: FeishuSourcePullRoute,
  deps: BuildSourceIngestionPayloadDeps = {},
): Promise<SourceIngestionPayload> {
  const pullDocumentBody = deps.pullDocumentBody ?? pullFeishuDocumentBody
  const pulled = await pullDocumentBody({
    originChannel: route.originChannel,
    originContextId: route.originContextId,
    sourceUrl: route.sourceUrl,
    docToken: route.docToken,
    wikiToken: route.wikiToken,
    wikiSpaceId: route.wikiSpaceId,
    folderToken: route.folderToken,
    ownerUserId: route.ownerUserId,
  })

  return {
    originChannel: route.originChannel,
    originContextId: route.originContextId,
    title: route.title ?? pulled.title,
    contentText: pulled.contentText,
    ownerUserId: route.ownerUserId ?? pulled.ownerUserId,
    sourceUrl: route.sourceUrl ?? pulled.sourceUrl,
    chatId: route.chatId,
    chatType: inferChatType(route.chatId),
    actorOpenId: route.actorOpenId,
    mentionedUserIds: route.mentionedUserIds,
    docToken: route.docToken ?? pulled.docToken,
    wikiSpaceId: route.wikiSpaceId ?? pulled.wikiSpaceId,
    folderToken: route.folderToken ?? pulled.folderToken,
    projectToBase: true,
  }
}

function inferChatType(chatId?: string): "group" | "p2p" | "unknown" {
  if (!chatId) return "unknown"
  return chatId.startsWith("ou_") ? "p2p" : "group"
}
