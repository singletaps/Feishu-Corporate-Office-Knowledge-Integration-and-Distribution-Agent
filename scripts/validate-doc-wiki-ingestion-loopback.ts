import assert from "node:assert/strict"
import { buildSourceIngestionPayloadFromPull } from "../src/application/feishu-source-pull-service.js"
import type { FeishuDocumentPuller } from "../src/integration/document.js"
import { mapFeishuEventToInboundRoute } from "../src/trigger/feishu-ingestion-adapter.js"
import { OriginChannel, type TriggerEvent } from "../src/shared/types.js"

process.env.FEISHU_DOC_EVENT_TYPES ??= "drive.file.document_updated_v1"
process.env.FEISHU_WIKI_EVENT_TYPES ??= "wiki.node.updated_v1"

function event(eventType: string, payload: Record<string, unknown>): TriggerEvent {
  return {
    eventId: `${eventType}_loopback`,
    eventType,
    source: "feishu_event",
    idempotencyKey: `${eventType}_loopback`,
    payload,
    occurredAt: new Date("2026-05-06T00:00:00.000Z"),
    receivedAt: new Date("2026-05-06T00:00:00.000Z"),
  }
}

const docEvent = event("doc_update", {
  event: {
    doc_token: "doc_mock_token",
    title: "脱敏需求评审文档",
    url: "https://example.feishu.cn/docx/doc_mock_token",
    operator_open_id: "ou_mock_editor",
  },
  folder_token: "fld_mock_folder",
})

const wikiEvent = event("wiki_update", {
  event: {
    wiki_token: "wikcn_mock_node",
    wiki_space_id: "spc_mock_space",
    doc_token: "doc_mock_from_wiki",
    title: "脱敏 Wiki 项目页",
    url: "https://example.feishu.cn/wiki/wikcn_mock_node",
    operator_open_id: "ou_mock_wiki_editor",
  },
})

const docAliasEvent = event("drive.file.document_updated_v1", {
  event: {
    doc_token: "doc_alias_token",
    title: "脱敏别名文档",
  },
})

async function main() {
  const calls: Array<{ originContextId: string; docToken?: string; wikiToken?: string }> = []
  const pullDocumentBody: FeishuDocumentPuller = async (request) => {
    calls.push({
      originContextId: request.originContextId,
      docToken: request.docToken,
      wikiToken: request.wikiToken,
    })
    return {
      title: `mock pulled ${request.originChannel}`,
      contentText: `请张三在周五前完成 ${request.originContextId} 的验收，并同步风险。`,
      ownerUserId: request.ownerUserId,
      sourceUrl: request.sourceUrl,
      docToken: request.docToken,
      wikiSpaceId: request.wikiSpaceId,
      folderToken: request.folderToken,
    }
  }

  const docRoute = mapFeishuEventToInboundRoute(docEvent)
  assert.equal(docRoute.kind, "source_pull")
  const docPayload = await buildSourceIngestionPayloadFromPull(docRoute, { pullDocumentBody })
  assert.equal(docPayload.originChannel, OriginChannel.Doc)
  assert.equal(docPayload.originContextId, "doc_mock_token")
  assert.equal(docPayload.docToken, "doc_mock_token")
  assert.equal(docPayload.folderToken, "fld_mock_folder")
  assert.equal(docPayload.sourceUrl, "https://example.feishu.cn/docx/doc_mock_token")
  assert.match(docPayload.contentText, /周五前完成/u)

  const docAliasRoute = mapFeishuEventToInboundRoute(docAliasEvent)
  assert.equal(docAliasRoute.kind, "source_pull")
  assert.equal(docAliasRoute.originChannel, OriginChannel.Doc)
  assert.equal(docAliasRoute.originContextId, "doc_alias_token")

  const wikiRoute = mapFeishuEventToInboundRoute(wikiEvent)
  assert.equal(wikiRoute.kind, "source_pull")
  const wikiPayload = await buildSourceIngestionPayloadFromPull(wikiRoute, { pullDocumentBody })
  assert.equal(wikiPayload.originChannel, OriginChannel.Wiki)
  assert.equal(wikiPayload.originContextId, "wikcn_mock_node")
  assert.equal(wikiPayload.docToken, "doc_mock_from_wiki")
  assert.equal(wikiPayload.wikiSpaceId, "spc_mock_space")
  assert.equal(wikiPayload.sourceUrl, "https://example.feishu.cn/wiki/wikcn_mock_node")
  assert.match(wikiPayload.contentText, /同步风险/u)

  console.log(JSON.stringify({
    ok: true,
    pulledCalls: calls,
    payloads: [
      {
        originChannel: docPayload.originChannel,
        originContextId: docPayload.originContextId,
        docToken: docPayload.docToken,
        folderToken: docPayload.folderToken,
        sourceUrl: docPayload.sourceUrl,
        contentLength: docPayload.contentText.length,
      },
      {
        originChannel: wikiPayload.originChannel,
        originContextId: wikiPayload.originContextId,
        docToken: wikiPayload.docToken,
        wikiSpaceId: wikiPayload.wikiSpaceId,
        sourceUrl: wikiPayload.sourceUrl,
        contentLength: wikiPayload.contentText.length,
      },
    ],
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
