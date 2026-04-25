import { larkCli } from "./lark-cli.js"
import { log } from "../evaluation/logger.js"
import type { MeetingMinutes, FeishuUser } from "../shared/types.js"

interface VcMeetingResponse {
  meeting?: {
    id?: string
    topic?: string
    start_time?: string
    end_time?: string
    participants?: Array<{ user?: { id?: string; user_name?: string } }>
  }
}

interface VcNotesResponse {
  minute_token?: string
  meeting_topic?: string
  owner?: { user_name?: string }
  paragraphs?: Array<{ paragraph?: { elements?: Array<{ text_run?: { text?: string } }> } }>
  todos?: Array<{ task_content?: string }>
  transcripts?: Array<{
    speaker?: { user_name?: string }
    paragraphs?: Array<{ sentence?: string }>
  }>
}

export async function getMeetingDetail(meetingId: string) {
  log.info("fetching meeting detail", { meetingId })
  const data = (await larkCli(["vc", "meeting", "get", "--meeting_id", meetingId])) as VcMeetingResponse
  const m = data?.meeting
  return {
    meetingId: m?.id ?? meetingId,
    title: m?.topic ?? "",
    participants: (m?.participants ?? []).map((p) => ({
      openId: p.user?.id ?? "",
      name: p.user?.user_name ?? "",
    })),
    startTime: m?.start_time ? new Date(Number(m.start_time) * 1000) : new Date(),
    endTime: m?.end_time ? new Date(Number(m.end_time) * 1000) : new Date(),
  }
}

export async function getMinutesByMeetingId(meetingId: string): Promise<MeetingMinutes> {
  log.info("fetching meeting minutes via +notes", { meetingId })
  const data = (await larkCli(["vc", "+notes", "--meeting-ids", meetingId])) as VcNotesResponse | VcNotesResponse[]

  const notes = Array.isArray(data) ? data[0] : data
  if (!notes) {
    log.warn("no notes found for meeting", { meetingId })
    return buildEmptyMinutes(meetingId)
  }

  return parseNotes(meetingId, notes)
}

export async function getMinutesByToken(minuteToken: string): Promise<MeetingMinutes> {
  log.info("fetching minutes by token", { minuteToken })
  const data = (await larkCli(["vc", "+notes", "--minute-tokens", minuteToken])) as VcNotesResponse | VcNotesResponse[]

  const notes = Array.isArray(data) ? data[0] : data
  if (!notes) {
    log.warn("no notes found for token", { minuteToken })
    return buildEmptyMinutes(minuteToken)
  }

  return parseNotes(minuteToken, notes)
}

export async function searchMeetings(params: {
  start?: string
  end?: string
  query?: string
  participantIds?: string
}) {
  log.info("searching meetings", params)
  const args = ["vc", "+search"]
  if (params.start) args.push("--start", params.start)
  if (params.end) args.push("--end", params.end)
  if (params.query) args.push("--query", params.query)
  if (params.participantIds) args.push("--participant-ids", params.participantIds)

  return larkCli(args)
}

function parseNotes(contextId: string, notes: VcNotesResponse): MeetingMinutes {
  const transcript = (notes.transcripts ?? [])
    .map((t) => {
      const speaker = t.speaker?.user_name ?? "Unknown"
      const text = (t.paragraphs ?? []).map((p) => p.sentence ?? "").join(" ")
      return `${speaker}: ${text}`
    })
    .join("\n")

  const paragraphText = (notes.paragraphs ?? [])
    .map((p) => (p.paragraph?.elements ?? []).map((e) => e.text_run?.text ?? "").join(""))
    .join("\n")

  const fullTranscript = transcript || paragraphText

  const actionItems = (notes.todos ?? []).map((t) => t.task_content ?? "")

  log.info("parsed meeting notes", {
    contextId,
    transcriptLength: fullTranscript.length,
    actionItemCount: actionItems.length,
  })

  return {
    meetingId: contextId,
    title: notes.meeting_topic ?? "",
    transcript: fullTranscript,
    actionItems,
    participants: [],
    startTime: new Date(),
    endTime: new Date(),
  }
}

function buildEmptyMinutes(contextId: string): MeetingMinutes {
  return {
    meetingId: contextId,
    title: "",
    transcript: "",
    actionItems: [],
    participants: [],
    startTime: new Date(),
    endTime: new Date(),
  }
}
