import { db } from "../shared/db.js"
import { log } from "../evaluation/logger.js"
import { callLLM } from "../domain/llm.js"
import {
  HubAssignmentFallbackAction,
  HubAssignmentType,
  HubImpactLevel,
  HubProjectionRole,
  applyDeterministicGuardrails,
  hubAssignmentDecisionSchema,
  type GuardrailResult,
  type HubAssignmentDecision,
  type HubEvidenceBundle,
} from "../domain/hub-assignment.js"
import { ensurePersonalHub, writeHubAudit } from "./hub-service.js"
import {
  collectSourceContext,
  saveSourceContextSnapshot,
  type SourceContextInput,
} from "./source-context-service.js"
import type { WorkItem } from "../shared/types.js"

export interface ApplyHubAssignmentResult {
  workItemId: string
  snapshotId: string
  decisionId: string
  autoApplied: boolean
  requiresHumanConfirmation: boolean
  appliedHubIds: string[]
  decision: HubAssignmentDecision
  guardrails: GuardrailResult
}

export async function collectSourceContextForAssignment(
  input: SourceContextInput,
): Promise<HubEvidenceBundle> {
  return collectSourceContext(input)
}

export async function decideWorkItemHub(
  evidence: HubEvidenceBundle,
  item?: Pick<WorkItem, "id" | "title" | "ownerUserId" | "itemType" | "confidenceScore">,
): Promise<HubAssignmentDecision> {
  try {
    const result = await callLLM(
      "workitem-hub-router",
      {
        evidenceBundle: JSON.stringify(evidence, null, 2),
        workItem: JSON.stringify(item ?? null, null, 2),
      },
      hubAssignmentDecisionSchema,
    )
    return result.data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("workitem hub router failed, using deterministic fallback", { error: message, workItemId: item?.id })
    return deterministicFallbackDecision(evidence, item)
  }
}

export async function applyHubAssignment(input: {
  workItem: WorkItem
  evidence: HubEvidenceBundle
  decision?: HubAssignmentDecision
  changedById?: string
}): Promise<ApplyHubAssignmentResult> {
  const snapshot = await saveSourceContextSnapshot(input.evidence, input.changedById)
  const rawDecision = input.decision ?? await decideWorkItemHub(input.evidence, input.workItem)
  const guardrails = applyDeterministicGuardrails(input.evidence, rawDecision)
  const decision = guardrails.finalDecision
  const appliedHubIds: string[] = []
  const shouldApply = !decision.requiresHumanConfirmation
    && decision.fallbackAction !== HubAssignmentFallbackAction.PendingQueue

  if (shouldApply) {
    if (decision.primaryHubId) {
      await ensureProjection({
        workItemId: input.workItem.id,
        hubId: decision.primaryHubId,
        role: HubProjectionRole.Primary,
        createdReason: mapAssignmentReason(decision.assignmentType),
        createdBy: input.changedById,
        visibility: "hub",
      })
      appliedHubIds.push(decision.primaryHubId)
    }

    for (const hubId of decision.mirrorHubIds) {
      await ensureProjection({
        workItemId: input.workItem.id,
        hubId,
        role: decision.assignmentType === HubAssignmentType.CollaborationPrimary
          ? HubProjectionRole.MirrorCollaboration
          : HubProjectionRole.MirrorTeam,
        createdReason: decision.assignmentType === HubAssignmentType.CollaborationPrimary
          ? "collaboration_mirror"
          : "agent_decision",
        createdBy: input.changedById,
        visibility: "hub",
      })
      appliedHubIds.push(hubId)
    }

    for (const userOpenId of decision.personalMirrorUserIds) {
      const personalHub = await ensurePersonalHub(userOpenId)
      await ensureProjection({
        workItemId: input.workItem.id,
        hubId: personalHub.id,
        role: HubProjectionRole.MirrorOwner,
        createdReason: "owner_personal_mirror",
        createdBy: input.changedById,
        visibility: decision.assignmentType === HubAssignmentType.PendingAssignment ? "private_pending" : "private",
      })
      appliedHubIds.push(personalHub.id)
    }

    await db.execute(
      `UPDATE work_items
       SET responsible_hub_id = $2,
           hub_assignment_source = $3,
           need_human_confirm = false,
           updated_at = now()
       WHERE id = $1`,
      [
        input.workItem.id,
        decision.responsibleHubId,
        mapHubAssignmentSource(decision.assignmentType),
      ],
    )
  } else {
    await markPending(input.workItem.id, decision, input.changedById)
  }

  const decisionId = await recordDecision({
    workItemId: input.workItem.id,
    snapshotId: snapshot.id,
    decision,
    guardrails,
    autoApplied: shouldApply,
    changedById: input.changedById,
  })

  await writeHubAudit({
    hubId: decision.primaryHubId,
    actorOpenId: input.changedById ?? null,
    action: shouldApply ? "hub_assignment_applied" : "hub_assignment_pending",
    targetType: "work_item",
    targetId: input.workItem.id,
    payload: {
      decisionId,
      snapshotId: snapshot.id,
      assignmentType: decision.assignmentType,
      confidence: decision.confidence,
      guardrailViolations: guardrails.violations,
    },
  })

  return {
    workItemId: input.workItem.id,
    snapshotId: snapshot.id,
    decisionId,
    autoApplied: shouldApply,
    requiresHumanConfirmation: decision.requiresHumanConfirmation,
    appliedHubIds: Array.from(new Set(appliedHubIds)),
    decision,
    guardrails,
  }
}

export async function explainHubAssignment(workItemId: string): Promise<{
  workItemId: string
  decisionReason: string | null
  evidenceRefs: string[]
  assignmentType: string | null
  confidence: number | null
  requiresHumanConfirmation: boolean | null
}> {
  const row = await db.queryOne<{
    decisionJson: HubAssignmentDecision
    assignmentType: string | null
    confidence: number | null
    requiresHumanConfirmation: boolean | null
  }>(
    `SELECT decision_json, assignment_type, confidence, requires_human_confirmation
     FROM hub_assignment_decisions
     WHERE work_item_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [workItemId],
  )

  return {
    workItemId,
    decisionReason: row?.decisionJson?.decisionReason ?? null,
    evidenceRefs: row?.decisionJson?.evidenceRefs ?? [],
    assignmentType: row?.assignmentType ?? null,
    confidence: row?.confidence ?? null,
    requiresHumanConfirmation: row?.requiresHumanConfirmation ?? null,
  }
}

function deterministicFallbackDecision(
  evidence: HubEvidenceBundle,
  item?: Pick<WorkItem, "ownerUserId" | "confidenceScore">,
): HubAssignmentDecision {
  const inherited = evidence.similarWorkItems.find((similar) => similar.primaryHubId)
  const explicitHubId = evidence.explicitBindings.hubIds[0]
    ?? evidence.explicitBindings.docBoundHubId
    ?? evidence.explicitBindings.chatBoundHubId
    ?? evidence.explicitBindings.calendarBoundHubId
    ?? null
  const chatCandidate = evidence.candidateHubs.find((hub) => hub.matchedBy.includes("chat_binding"))
  const resourceCandidate = evidence.candidateHubs.find((hub) => hub.matchedBy.includes("resource_binding"))
  const isPrivateChat = evidence.resourceContext.chatType === "p2p"
  const ownerUserId = item?.ownerUserId ?? evidence.peopleContext.mentionedUsers[0] ?? null

  if (inherited?.primaryHubId) {
    return baseDecision({
      primaryHubId: inherited.primaryHubId,
      assignmentType: HubAssignmentType.InheritExistingItem,
      confidence: 0.9,
      reason: "发现同来源历史 WorkItem，继承其 primary Hub。",
      evidenceRefs: [`similar_work_item:${inherited.workItemId}`],
      personalMirrorUserIds: ownerUserId ? [ownerUserId] : [],
    })
  }

  if (explicitHubId) {
    return baseDecision({
      primaryHubId: explicitHubId,
      assignmentType: HubAssignmentType.ExplicitHub,
      confidence: 0.95,
      reason: "存在显式 Hub 绑定，按绑定 Hub 作为 primary。",
      evidenceRefs: [`explicit_binding:${explicitHubId}`],
      personalMirrorUserIds: ownerUserId ? [ownerUserId] : [],
    })
  }

  if (!isPrivateChat && chatCandidate) {
    return baseDecision({
      primaryHubId: chatCandidate.hubId,
      assignmentType: HubAssignmentType.ChatPrimary,
      confidence: 0.86,
      reason: "来源 chat 已绑定 Hub，按 chat 上下文作为 primary。",
      evidenceRefs: [`chat_binding:${chatCandidate.hubId}`],
      personalMirrorUserIds: ownerUserId ? [ownerUserId] : [],
    })
  }

  if (!isPrivateChat && resourceCandidate) {
    return baseDecision({
      primaryHubId: resourceCandidate.hubId,
      assignmentType: evidence.source.originChannel === "doc" || evidence.source.originChannel === "wiki"
        ? HubAssignmentType.DocPrimary
        : HubAssignmentType.CalendarPrimary,
      confidence: 0.82,
      reason: "命中资源到 Hub 的绑定，按资源上下文作为 primary。",
      evidenceRefs: [`resource_binding:${resourceCandidate.hubId}`],
      personalMirrorUserIds: ownerUserId ? [ownerUserId] : [],
    })
  }

  return baseDecision({
    primaryHubId: null,
    assignmentType: ownerUserId ? HubAssignmentType.PersonalPrimary : HubAssignmentType.PendingAssignment,
    confidence: item?.confidenceScore ?? 0.6,
    reason: ownerUserId
      ? "没有团队来源上下文，保守进入 owner 个人镜像。"
      : "没有足够 Hub 或 owner 证据，进入待确认。",
    evidenceRefs: ["deterministic_fallback"],
    personalMirrorUserIds: ownerUserId ? [ownerUserId] : [],
    fallbackAction: ownerUserId ? HubAssignmentFallbackAction.PersonalHub : HubAssignmentFallbackAction.PendingQueue,
  })
}

function baseDecision(input: {
  primaryHubId: string | null
  assignmentType: HubAssignmentType
  confidence: number
  reason: string
  evidenceRefs: string[]
  personalMirrorUserIds: string[]
  fallbackAction?: HubAssignmentFallbackAction | null
}): HubAssignmentDecision {
  return {
    primaryHubId: input.primaryHubId,
    responsibleHubId: null,
    mirrorHubIds: [],
    personalMirrorUserIds: input.personalMirrorUserIds,
    ownerCandidates: input.personalMirrorUserIds.map((openId) => ({
      openId,
      confidence: 0.75,
      reason: "owner or explicit participant",
    })),
    assignmentType: input.assignmentType,
    confidence: input.confidence,
    impactLevel: HubImpactLevel.Medium,
    requiresHumanConfirmation: false,
    decisionReason: input.reason,
    evidenceRefs: input.evidenceRefs,
    fallbackAction: input.fallbackAction ?? null,
  }
}

async function ensureProjection(input: {
  workItemId: string
  hubId: string
  role: HubProjectionRole
  createdReason: string
  createdBy?: string
  visibility: "hub" | "private" | "private_pending" | "restricted" | "archived_summary"
}): Promise<void> {
  if (input.role === HubProjectionRole.Primary) {
    await db.execute(
      `UPDATE work_item_hub_projections
       SET projection_role = 'mirror_team',
           sync_status = CASE WHEN sync_status = 'removed' THEN 'removed' ELSE sync_status END,
           updated_at = now()
       WHERE work_item_id = $1
         AND projection_role = 'primary'
         AND hub_id <> $2
         AND sync_status <> 'removed'`,
      [input.workItemId, input.hubId],
    )
  }

  await db.execute(
    `INSERT INTO work_item_hub_projections
       (work_item_id, hub_id, projection_role, created_reason, created_by, visibility)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (work_item_id, hub_id)
     DO UPDATE SET projection_role = EXCLUDED.projection_role,
                   created_reason = COALESCE(work_item_hub_projections.created_reason, EXCLUDED.created_reason),
                   created_by = COALESCE(work_item_hub_projections.created_by, EXCLUDED.created_by),
                   visibility = EXCLUDED.visibility,
                   sync_status = CASE
                     WHEN work_item_hub_projections.sync_status = 'removed' THEN 'pending'
                     ELSE work_item_hub_projections.sync_status
                   END,
                   updated_at = now()`,
    [
      input.workItemId,
      input.hubId,
      input.role,
      input.createdReason,
      input.createdBy ?? null,
      input.visibility,
    ],
  )
}

async function markPending(
  workItemId: string,
  decision: HubAssignmentDecision,
  changedById?: string,
): Promise<void> {
  await db.execute(
    `UPDATE work_items
     SET status = CASE WHEN status = 'new' THEN 'pending_review' ELSE status END,
         need_human_confirm = true,
         hub_assignment_source = 'pending',
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = now()
     WHERE id = $1`,
    [
      workItemId,
      JSON.stringify({ pendingHubAssignment: { reason: decision.decisionReason, changedById: changedById ?? null } }),
    ],
  )
}

async function recordDecision(input: {
  workItemId: string
  snapshotId: string
  decision: HubAssignmentDecision
  guardrails: GuardrailResult
  autoApplied: boolean
  changedById?: string
}): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO hub_assignment_decisions
       (work_item_id, source_context_snapshot_id, primary_hub_id, responsible_hub_id,
        decision_json, guardrail_json, confidence, impact_level, assignment_type,
        auto_applied, requires_human_confirmation, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.workItemId,
      input.snapshotId,
      input.decision.primaryHubId,
      input.decision.responsibleHubId,
      JSON.stringify(input.decision),
      JSON.stringify({
        allowed: input.guardrails.allowed,
        violations: input.guardrails.violations,
        auditNotes: input.guardrails.auditNotes,
      }),
      input.decision.confidence,
      input.decision.impactLevel,
      input.decision.assignmentType,
      input.autoApplied,
      input.decision.requiresHumanConfirmation,
      input.changedById ?? null,
    ],
  )
  return rows[0].id
}

function mapAssignmentReason(type: HubAssignmentType): string {
  if (type === HubAssignmentType.ExplicitHub) return "explicit_binding"
  if (type === HubAssignmentType.InheritExistingItem) return "inherited"
  if (type === HubAssignmentType.PersonalPrimary) return "owner_personal_mirror"
  return "agent_decision"
}

function mapHubAssignmentSource(type: HubAssignmentType): WorkItem["hubAssignmentSource"] {
  if (type === HubAssignmentType.ExplicitHub) return "explicit_binding"
  if (type === HubAssignmentType.ChatPrimary) return "chat_context"
  if (type === HubAssignmentType.DocPrimary) return "doc_context"
  if (type === HubAssignmentType.CalendarPrimary) return "calendar_context"
  if (type === HubAssignmentType.InheritExistingItem) return "inherited"
  if (type === HubAssignmentType.PersonalPrimary) return "personal_fallback"
  if (type === HubAssignmentType.PendingAssignment) return "pending"
  return "agent_decision"
}
