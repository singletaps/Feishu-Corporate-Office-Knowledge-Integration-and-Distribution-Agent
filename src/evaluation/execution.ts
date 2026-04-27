import { db } from "../shared/db.js"

export async function startExecution(params: {
  workflowName: string
  triggerType?: string
  triggerContextId?: string
}): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO execution_records (workflow_name, trigger_type, trigger_context_id, status, started_at)
     VALUES ($1, $2, $3, 'running', now()) RETURNING id`,
    [params.workflowName, params.triggerType ?? null, params.triggerContextId ?? null],
  )
  return rows[0].id
}

export async function finishExecution(executionId: string): Promise<void> {
  await db.execute(
    `UPDATE execution_records
     SET status = 'succeeded', finished_at = now(), error_code = NULL, error_message = NULL
     WHERE id = $1`,
    [executionId],
  )
}

export async function failExecution(executionId: string, error: unknown): Promise<void> {
  const err = error instanceof Error ? error : new Error(String(error))
  await db.execute(
    `UPDATE execution_records
     SET status = 'failed', finished_at = now(), error_code = $2, error_message = $3
     WHERE id = $1`,
    [executionId, err.name, err.message],
  )
}
