import type { WorkItem, KnowledgeArtifact } from "../shared/types.js"

const TYPE_LABELS: Record<string, string> = {
  todo: "待办",
  decision: "决策",
  risk: "风险",
  blocker: "阻塞",
}

const STATUS_LABELS: Record<string, string> = {
  new: "新建",
  pending_review: "待确认",
  active: "进行中",
  blocked: "已阻塞",
  done: "已完成",
  closed: "已关闭",
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: "red",
  high: "orange",
  medium: "blue",
  low: "grey",
}

function confidenceTag(score: number | null): string {
  if (score === null) return ""
  if (score >= 0.8) return "🟢 高"
  if (score >= 0.6) return "🟡 中"
  return "🔴 低"
}

export function renderPostMeetingCard(items: WorkItem[], meetingTitle: string): Record<string, unknown> {
  const itemElements = items.map((item, idx) => {
    const typeLabel = TYPE_LABELS[item.itemType] ?? item.itemType
    const confidence = confidenceTag(item.confidenceScore)
    const owner = item.ownerUserId ? `<at id="${item.ownerUserId}"></at>` : "未指定"
    const due = item.dueAt ? new Date(item.dueAt).toLocaleDateString("zh-CN") : "无"

    return [
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "default",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "markdown",
                content: `**${idx + 1}. ${item.title}**\n类型: ${typeLabel} | 置信度: ${confidence}\n负责人: ${owner} | 截止: ${due}`,
              },
            ],
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 确认" },
            type: "primary",
            value: { action: "confirm", workItemId: item.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✏️ 修改" },
            type: "default",
            value: { action: "modify", workItemId: item.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ 驳回" },
            type: "danger",
            value: { action: "reject", workItemId: item.id },
          },
        ],
      },
      { tag: "hr" },
    ]
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📋 会后事项确认 — ${meetingTitle}` },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: `共抽取 **${items.length}** 条事项，请逐条确认或修改。`,
      },
      { tag: "hr" },
      ...itemElements.flat(),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ 全部确认" },
            type: "primary",
            value: { action: "confirm_all" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "➕ 补充遗漏" },
            type: "default",
            value: { action: "add_missing" },
          },
        ],
      },
    ],
  }
}

export function renderRiskAlertCard(items: WorkItem[]): Record<string, unknown> {
  const itemLines = items
    .map((item) => {
      const status = STATUS_LABELS[item.status] ?? item.status
      const overdueDays = item.dueAt
        ? Math.floor((Date.now() - new Date(item.dueAt).getTime()) / 86400000)
        : null
      const overdueText = overdueDays && overdueDays > 0 ? `超期 ${overdueDays} 天` : ""
      return `- **${item.title}**\n  状态: ${status} ${overdueText}`
    })
    .join("\n")

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "⚠️ 风险预警" },
      template: "red",
    },
    elements: [
      {
        tag: "markdown",
        content: `发现 **${items.length}** 条需要关注的事项：\n\n${itemLines}`,
      },
    ],
  }
}

export function renderPreMeetingCard(brief: KnowledgeArtifact): Record<string, unknown> {
  const payload = brief.contentPayload ?? {}
  const relatedItems = (payload.relatedItems as string[]) ?? []
  const relatedDocs = (payload.relatedDocs as string[]) ?? []

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `📖 会前背景 — ${brief.title ?? "会议"}` },
      template: "green",
    },
    elements: [
      {
        tag: "markdown",
        content: brief.summary ?? "暂无背景摘要",
      },
      ...(relatedItems.length > 0
        ? [
            { tag: "hr" },
            { tag: "markdown", content: `**相关未结事项：**\n${relatedItems.map((i) => `- ${i}`).join("\n")}` },
          ]
        : []),
      ...(relatedDocs.length > 0
        ? [
            { tag: "hr" },
            { tag: "markdown", content: `**相关文档：**\n${relatedDocs.map((d) => `- ${d}`).join("\n")}` },
          ]
        : []),
    ],
  }
}

export function renderWeeklyInsightCard(insight: KnowledgeArtifact): Record<string, unknown> {
  const payload = insight.contentPayload ?? {}
  const counts = (payload.counts as Record<string, number>) ?? {}
  const risks = (payload.riskItems as Array<{ title: string; status: string; ownerUserId?: string }>) ?? []
  const overdue = (payload.overdueItems as Array<{ title: string; status: string; ownerUserId?: string }>) ?? []

  const riskLines = risks.length > 0
    ? risks.map((item) => `- ${item.title}（${item.status}）`).join("\n")
    : "- 暂无高风险事项"

  const overdueLines = overdue.length > 0
    ? overdue.map((item) => `- ${item.title}（${item.status}）`).join("\n")
    : "- 暂无超期事项"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: insight.title ?? "团队重点事项周洞察" },
      template: "blue",
    },
    elements: [
      { tag: "markdown", content: insight.summary ?? "暂无摘要" },
      { tag: "hr" },
      {
        tag: "markdown",
        content: `**状态统计**\n- 进行中：${counts.active ?? 0}\n- 待确认：${counts.pending_review ?? 0}\n- 阻塞：${counts.blocked ?? 0}\n- 已完成：${counts.done ?? 0}`,
      },
      { tag: "hr" },
      { tag: "markdown", content: `**风险/阻塞事项**\n${riskLines}` },
      { tag: "hr" },
      { tag: "markdown", content: `**超期事项**\n${overdueLines}` },
    ],
  }
}
