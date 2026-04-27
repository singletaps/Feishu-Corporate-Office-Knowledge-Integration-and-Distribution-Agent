import { writeFileSync } from "node:fs"
import { db } from "../shared/db.js"
import { log } from "./logger.js"
import type { WorkItem } from "../shared/types.js"

interface MetricResult {
  name: string
  score: number
  details: Record<string, unknown>
}

export async function runEvaluationReport(outputPath = "效果验证报告.md"): Promise<{ outputPath: string; metrics: MetricResult[] }> {
  const items = await db.query<WorkItem>(
    `SELECT * FROM work_items WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`,
  )
  const pushRows = await db.query<{ deliveryStatus: string; clicked: boolean }>(
    `SELECT delivery_status, clicked FROM push_records ORDER BY created_at DESC LIMIT 500`,
  )
  const executions = await db.query<{ status: string }>(
    `SELECT status FROM execution_records ORDER BY created_at DESC LIMIT 500`,
  )

  const metrics = [
    workItemTraceability(items),
    ownerCompletion(items),
    dueDateCompletion(items),
    pushAcceptance(pushRows),
    executionSuccess(executions),
  ]

  await persistMetrics(metrics)

  const markdown = renderReport(metrics, items.length)
  writeFileSync(outputPath, markdown, "utf-8")

  log.info("evaluation report generated", { outputPath, metricCount: metrics.length })
  return { outputPath, metrics }
}

function workItemTraceability(items: WorkItem[]): MetricResult {
  const withOrigin = items.filter((item) => item.originChannel && item.originContextId).length
  return {
    name: "来源可追溯率",
    score: ratio(withOrigin, items.length),
    details: { withOrigin, total: items.length },
  }
}

function ownerCompletion(items: WorkItem[]): MetricResult {
  const todos = items.filter((item) => item.itemType === "todo")
  const withOwner = todos.filter((item) => item.ownerUserId).length
  return {
    name: "负责人补齐率",
    score: ratio(withOwner, todos.length),
    details: { withOwner, totalTodo: todos.length },
  }
}

function dueDateCompletion(items: WorkItem[]): MetricResult {
  const todos = items.filter((item) => item.itemType === "todo")
  const withDue = todos.filter((item) => item.dueAt).length
  return {
    name: "截止时间补齐率",
    score: ratio(withDue, todos.length),
    details: { withDue, totalTodo: todos.length },
  }
}

function pushAcceptance(rows: Array<{ deliveryStatus: string; clicked: boolean }>): MetricResult {
  const delivered = rows.filter((row) => row.deliveryStatus === "sent" || row.deliveryStatus === "acknowledged").length
  const clicked = rows.filter((row) => row.clicked).length
  return {
    name: "卡片接受度",
    score: ratio(clicked, delivered),
    details: { clicked, delivered },
  }
}

function executionSuccess(rows: Array<{ status: string }>): MetricResult {
  const succeeded = rows.filter((row) => row.status === "succeeded").length
  return {
    name: "工作流成功率",
    score: ratio(succeeded, rows.length),
    details: { succeeded, total: rows.length },
  }
}

async function persistMetrics(metrics: MetricResult[]): Promise<void> {
  for (const metric of metrics) {
    await db.execute(
      `INSERT INTO evaluation_records (eval_type, case_name, score, metric_data, created_at)
       VALUES ('metric_snapshot', $1, $2, $3, now())`,
      [metric.name, metric.score, JSON.stringify(metric.details)],
    )
  }
}

function renderReport(metrics: MetricResult[], totalItems: number): string {
  const rows = metrics.map((metric) => `| ${metric.name} | ${(metric.score * 100).toFixed(1)}% | ${JSON.stringify(metric.details)} |`).join("\n")
  return `# 效果验证报告

## 数据范围

- 当前事项总数：${totalItems}
- 生成时间：${new Date().toISOString()}

## 核心指标

| 指标 | 分数 | 详情 |
| --- | --- | --- |
${rows}

## 对三项挑战的验证

### 挑战一：重新定义知识获取

系统不直接把会议纪要、文档或消息作为最终知识，而是将其转化为 WorkItem、KnowledgeArtifact 和来源引用。来源可追溯率用于验证每条事项是否能回到原始上下文。

### 挑战二：构建场景化知识应用

系统已支持会后事项抽取、重点事项推进总表、风险巡检、周报洞察和主动卡片推送。卡片接受度用于验证知识产物是否以合适形态触达用户。

### 挑战三：证明应用效果与价值

负责人补齐率、截止时间补齐率、工作流成功率用于证明系统是否减少人工整理成本、提高事项闭环能力。后续接入真实人工标注后，可继续补充 Precision / Recall / F1。
`
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return numerator / denominator
}
