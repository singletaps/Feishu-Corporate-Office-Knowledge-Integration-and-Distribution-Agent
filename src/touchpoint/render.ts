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

const PRIORITY_LABELS: Record<string, string> = {
  critical: "紧急",
  high: "高",
  medium: "中",
  low: "低",
}

function confidenceTag(score: number | null): string {
  if (score === null) return ""
  if (score >= 0.8) return "🟢 高"
  if (score >= 0.6) return "🟡 中"
  return "🔴 低"
}

function renderUserLabel(userId: string | null | undefined): string {
  if (!userId) return "未指定"
  return userId
}

export function renderPostMeetingCard(items: WorkItem[], meetingTitle: string): Record<string, unknown> {
  const itemElements = items.map((item, idx) => {
    const typeLabel = TYPE_LABELS[item.itemType] ?? item.itemType
    const confidence = confidenceTag(item.confidenceScore)
    const owner = renderUserLabel(item.ownerUserId)
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
            value: { action: "workitem.confirm", workItemId: item.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✏️ 修改" },
            type: "default",
            value: { action: "workitem.edit", workItemId: item.id },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ 驳回" },
            type: "danger",
            value: { action: "workitem.reject", workItemId: item.id },
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
            value: { action: "workitem.confirm_all" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "➕ 补充遗漏" },
            type: "default",
            value: { action: "workitem.add_missing" },
          },
        ],
      },
    ],
  }
}

export function renderWorkItemDraftCard(input: {
  title: string
  hubId: string
  actorOpenId?: string
}): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "新建 WorkItem 草稿" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: "请补全待办信息。提交后才会加入当前 Hub。",
        },
        {
          tag: "form",
          name: "workitemDraftForm",
          elements: [
            {
              tag: "input",
              name: "title",
              required: true,
              placeholder: { tag: "plain_text", content: "请输入待办标题" },
              default_value: input.title,
              width: "fill",
            },
            {
              tag: "input",
              name: "detail",
              placeholder: { tag: "plain_text", content: "补充背景、验收标准、相关链接等" },
              default_value: "",
              width: "fill",
            },
            {
              tag: "input",
              name: "ownerUserId",
              placeholder: { tag: "plain_text", content: input.actorOpenId ?? "负责人 open_id，可留空" },
              default_value: input.actorOpenId ?? "",
              width: "fill",
            },
            {
              tag: "select_static",
              name: "itemType",
              required: true,
              placeholder: { tag: "plain_text", content: "事项类型" },
              initial_option: "todo",
              options: [
                { text: { tag: "plain_text", content: "待办" }, value: "todo" },
                { text: { tag: "plain_text", content: "决策" }, value: "decision" },
                { text: { tag: "plain_text", content: "风险" }, value: "risk" },
                { text: { tag: "plain_text", content: "阻塞" }, value: "blocker" },
              ],
              width: "fill",
            },
            {
              tag: "select_static",
              name: "priority",
              required: true,
              placeholder: { tag: "plain_text", content: "优先级" },
              initial_option: "medium",
              options: [
                { text: { tag: "plain_text", content: "低" }, value: "low" },
                { text: { tag: "plain_text", content: "中" }, value: "medium" },
                { text: { tag: "plain_text", content: "高" }, value: "high" },
                { text: { tag: "plain_text", content: "紧急" }, value: "critical" },
              ],
              width: "fill",
            },
            {
              tag: "input",
              name: "startDate",
              placeholder: { tag: "plain_text", content: "开始日期，例如 2026-04-28，可留空" },
              default_value: "",
              width: "fill",
            },
            {
              tag: "input",
              name: "dueDate",
              placeholder: { tag: "plain_text", content: "截止日期，例如 2026-04-30，可留空" },
              default_value: "",
              width: "fill",
            },
            {
              tag: "button",
              name: "submitDraft",
              text: { tag: "plain_text", content: "提交到 Hub" },
              type: "primary_filled",
              form_action_type: "submit",
              value: {
                action: "workitem.submit_draft",
                hubId: input.hubId,
                actorOpenId: input.actorOpenId,
                draftTitle: input.title,
              },
            },
          ],
        },
      ],
    },
  }
}

export function renderWorkItemListCard(input: {
  items: WorkItem[]
  hubId: string
  title?: string
}): Record<string, unknown> {
  const itemElements = input.items.flatMap((item, index) => [
    renderWorkItemSummaryBlock(item, index + 1),
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "标记完成" },
          type: "primary",
          value: { action: "workitem.mark_done", workItemId: item.id, hubId: input.hubId },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "延期 1 天" },
          type: "default",
          value: { action: "workitem.delay", workItemId: item.id, hubId: input.hubId, days: 1 },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "延期 7 天" },
          type: "default",
          value: { action: "workitem.delay", workItemId: item.id, hubId: input.hubId, days: 7 },
        },
      ],
    },
    { tag: "hr" },
  ])

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: input.title ?? "WorkItem 列表" },
      template: "blue",
    },
    elements: input.items.length > 0
      ? [
          { tag: "markdown", content: `当前 Hub 共有 **${input.items.length}** 条事项。` },
          { tag: "hr" },
          ...itemElements,
        ]
      : [{ tag: "markdown", content: "当前 Hub 暂无待办。" }],
  }
}

function renderWorkItemSummaryBlock(item: WorkItem, index: number): Record<string, unknown> {
  const typeLabel = TYPE_LABELS[item.itemType] ?? item.itemType
  const status = STATUS_LABELS[item.status] ?? item.status
  const priority = item.priority ? (PRIORITY_LABELS[item.priority] ?? item.priority) : "未设"
  const owner = renderUserLabel(item.ownerUserId)
  const due = item.dueAt ? new Date(item.dueAt).toLocaleDateString("zh-CN") : "未设"
  const confidence = confidenceTag(item.confidenceScore) || "未评估"
  const detail = typeof item.metadata?.detail === "string" && item.metadata.detail
    ? `\n详情：${item.metadata.detail}`
    : ""

  return {
    tag: "markdown",
    content: [
      `**${index}. ${item.title}**`,
      `类型：${typeLabel} | 状态：${status} | 优先级：${priority}`,
      `负责人：${owner} | 截止：${due} | 置信度：${confidence}`,
      `来源：${item.originChannel}:${item.originContextId}`,
      `ID：${item.id}${detail}`,
    ].join("\n"),
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
  const relatedItems = Array.isArray(payload.relatedItems) ? payload.relatedItems : []
  const relatedDocs = (payload.relatedDocs as string[]) ?? []
  const relatedItemLines = relatedItems.map((item) => {
    if (typeof item === "string") return `- ${item}`
    if (item && typeof item === "object" && "title" in item) {
      const typed = item as { title?: string; status?: string }
      return `- ${typed.title ?? "未命名事项"}${typed.status ? `（${typed.status}）` : ""}`
    }
    return "- 未命名事项"
  })

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
            { tag: "markdown", content: `**相关未结事项：**\n${relatedItemLines.join("\n")}` },
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
