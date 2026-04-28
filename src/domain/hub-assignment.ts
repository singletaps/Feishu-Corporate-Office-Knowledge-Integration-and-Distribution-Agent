import { z } from "zod"
import type { OriginChannel } from "../shared/types.js"

export const HubAssignmentType = {
  ExplicitHub: "explicit_hub",
  ChatPrimary: "chat_primary",
  DocPrimary: "doc_primary",
  CalendarPrimary: "calendar_primary",
  PersonalPrimary: "personal_primary",
  CollaborationPrimary: "collaboration_primary",
  InheritExistingItem: "inherit_existing_item",
  PendingAssignment: "pending_assignment",
} as const
export type HubAssignmentType = (typeof HubAssignmentType)[keyof typeof HubAssignmentType]

export const HubImpactLevel = {
  Low: "low",
  Medium: "medium",
  High: "high",
} as const
export type HubImpactLevel = (typeof HubImpactLevel)[keyof typeof HubImpactLevel]

export const HubProjectionRole = {
  Primary: "primary",
  MirrorOwner: "mirror_owner",
  MirrorParticipant: "mirror_participant",
  MirrorCollaboration: "mirror_collaboration",
  MirrorPersonal: "mirror_personal",
  MirrorTeam: "mirror_team",
} as const
export type HubProjectionRole = (typeof HubProjectionRole)[keyof typeof HubProjectionRole]

export const HubAssignmentFallbackAction = {
  PersonalHub: "personal_hub",
  PendingQueue: "pending_queue",
  HumanConfirmation: "human_confirmation",
} as const
export type HubAssignmentFallbackAction =
  (typeof HubAssignmentFallbackAction)[keyof typeof HubAssignmentFallbackAction]

export interface HubCandidate {
  hubId: string
  hubType: "team" | "personal" | "org" | "legacy" | "collaboration"
  name: string
  matchedBy: string[]
  membersInvolved: string[]
  priorScore: number
}

export interface HubEvidenceBundle {
  source: {
    originChannel: OriginChannel
    originContextId: string
    sourceUrl?: string | null
    eventType?: string | null
  }
  explicitBindings: {
    hubIds: string[]
    docBoundHubId?: string | null
    chatBoundHubId?: string | null
    calendarBoundHubId?: string | null
  }
  resourceContext: {
    chatId?: string | null
    chatType?: "group" | "p2p" | "unknown" | null
    chatName?: string | null
    calendarEventId?: string | null
    calendarOrganizerOpenId?: string | null
    docToken?: string | null
    docOwnerOpenId?: string | null
    wikiSpaceId?: string | null
    folderToken?: string | null
  }
  peopleContext: {
    actorOpenId?: string | null
    participants: string[]
    attendees: string[]
    mentionedUsers: string[]
    editors: string[]
    commentAuthors: string[]
  }
  candidateHubs: HubCandidate[]
  contentSignals: {
    title?: string | null
    excerpt?: string | null
    mentionedTeams: string[]
    actionVerbs: string[]
    sensitive: boolean
  }
  similarWorkItems: Array<{
    workItemId: string
    primaryHubId: string | null
    similarityReason: string
  }>
}

export interface HubAssignmentDecision {
  primaryHubId: string | null
  responsibleHubId: string | null
  mirrorHubIds: string[]
  personalMirrorUserIds: string[]
  ownerCandidates: Array<{
    openId: string
    confidence: number
    reason: string
  }>
  assignmentType: HubAssignmentType
  confidence: number
  impactLevel: HubImpactLevel
  requiresHumanConfirmation: boolean
  decisionReason: string
  evidenceRefs: string[]
  fallbackAction: HubAssignmentFallbackAction | null
}

export interface GuardrailResult {
  allowed: boolean
  finalDecision: HubAssignmentDecision
  violations: string[]
  auditNotes: string[]
}

export const hubAssignmentDecisionSchema: z.ZodType<HubAssignmentDecision> = z.object({
  primaryHubId: z.string().uuid().nullable(),
  responsibleHubId: z.string().uuid().nullable(),
  mirrorHubIds: z.array(z.string().uuid()),
  personalMirrorUserIds: z.array(z.string()),
  ownerCandidates: z.array(z.object({
    openId: z.string(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })),
  assignmentType: z.enum([
    "explicit_hub",
    "chat_primary",
    "doc_primary",
    "calendar_primary",
    "personal_primary",
    "collaboration_primary",
    "inherit_existing_item",
    "pending_assignment",
  ]),
  confidence: z.number().min(0).max(1),
  impactLevel: z.enum(["low", "medium", "high"]),
  requiresHumanConfirmation: z.boolean(),
  decisionReason: z.string(),
  evidenceRefs: z.array(z.string()),
  fallbackAction: z.enum(["personal_hub", "pending_queue", "human_confirmation"]).nullable(),
})

const AUTO_EXECUTE_CONFIDENCE = 0.78
const PENDING_CONFIDENCE = 0.55

export function shouldAutoApplyDecision(decision: HubAssignmentDecision): boolean {
  return decision.confidence >= AUTO_EXECUTE_CONFIDENCE
    && decision.impactLevel !== HubImpactLevel.High
    && !decision.requiresHumanConfirmation
}

export function normalizeDecisionByConfidence(decision: HubAssignmentDecision): HubAssignmentDecision {
  if (shouldAutoApplyDecision(decision)) return decision

  if (decision.confidence < PENDING_CONFIDENCE) {
    return toPendingDecision(decision, "归属置信度低于自动处理阈值。")
  }

  if (decision.impactLevel === HubImpactLevel.High || decision.requiresHumanConfirmation) {
    return {
      ...decision,
      requiresHumanConfirmation: true,
      fallbackAction: HubAssignmentFallbackAction.HumanConfirmation,
    }
  }

  return {
    ...decision,
    fallbackAction: decision.fallbackAction ?? HubAssignmentFallbackAction.PendingQueue,
  }
}

export function applyDeterministicGuardrails(
  evidence: HubEvidenceBundle,
  decision: HubAssignmentDecision,
): GuardrailResult {
  const violations: string[] = []
  const auditNotes: string[] = []
  let finalDecision = normalizeDecisionByConfidence(decision)

  const explicitHubId = evidence.explicitBindings.hubIds[0]
    ?? evidence.explicitBindings.docBoundHubId
    ?? evidence.explicitBindings.chatBoundHubId
    ?? evidence.explicitBindings.calendarBoundHubId
    ?? null

  if (explicitHubId && finalDecision.primaryHubId && finalDecision.primaryHubId !== explicitHubId) {
    violations.push("explicit_binding_overridden")
    finalDecision = {
      ...finalDecision,
      primaryHubId: explicitHubId,
      assignmentType: HubAssignmentType.ExplicitHub,
      requiresHumanConfirmation: true,
      fallbackAction: HubAssignmentFallbackAction.HumanConfirmation,
      decisionReason: `${finalDecision.decisionReason}；显式 Hub 绑定优先，迁移 primary Hub 需要确认。`,
      evidenceRefs: dedupe([...finalDecision.evidenceRefs, `explicit_binding:${explicitHubId}`]),
    }
  }

  if (evidence.resourceContext.chatType === "p2p" && finalDecision.primaryHubId) {
    const primaryCandidate = evidence.candidateHubs.find((hub) => hub.hubId === finalDecision.primaryHubId)
    if (primaryCandidate?.hubType === "team") {
      violations.push("private_chat_team_primary")
      finalDecision = toPendingDecision(finalDecision, "私聊内容不能默认进入团队 Hub。")
    }
  }

  if (evidence.source.originChannel === "doc" || evidence.source.originChannel === "wiki") {
    if (evidence.explicitBindings.docBoundHubId && evidence.resourceContext.chatId) {
      auditNotes.push("forwarded_chat_does_not_override_doc_binding")
    }
    const riskyMirrors = finalDecision.mirrorHubIds.filter((hubId) => {
      const candidate = evidence.candidateHubs.find((hub) => hub.hubId === hubId)
      return candidate?.matchedBy.includes("mentioned_user_member") && !candidate.matchedBy.includes("resource_binding")
    })
    if (riskyMirrors.length > 0) {
      violations.push("mention_team_mirror_requires_confirmation")
      finalDecision = {
        ...finalDecision,
        requiresHumanConfirmation: true,
        fallbackAction: HubAssignmentFallbackAction.HumanConfirmation,
        decisionReason: `${finalDecision.decisionReason}；评论 @ 只影响责任人和触达，不自动扩散到被 @ 人所在团队。`,
      }
    }
  }

  if (finalDecision.impactLevel === HubImpactLevel.High && !finalDecision.requiresHumanConfirmation) {
    violations.push("high_impact_without_confirmation")
    finalDecision = {
      ...finalDecision,
      requiresHumanConfirmation: true,
      fallbackAction: HubAssignmentFallbackAction.HumanConfirmation,
    }
  }

  return {
    allowed: violations.length === 0 || finalDecision.fallbackAction !== null || finalDecision.requiresHumanConfirmation,
    finalDecision,
    violations,
    auditNotes,
  }
}

export function toPendingDecision(
  decision: HubAssignmentDecision,
  reason: string,
): HubAssignmentDecision {
  return {
    ...decision,
    primaryHubId: null,
    mirrorHubIds: [],
    assignmentType: HubAssignmentType.PendingAssignment,
    requiresHumanConfirmation: true,
    decisionReason: `${decision.decisionReason}${decision.decisionReason ? "；" : ""}${reason}`,
    fallbackAction: HubAssignmentFallbackAction.PendingQueue,
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}
