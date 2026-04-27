import { extractMeetingItemsFlow } from "../src/application/work-item-service.js"
import { db } from "../src/shared/db.js"

const meetingId = process.argv[2]
const chatId = process.argv[3]

if (!meetingId) {
  console.error("Usage: npx tsx scripts/run-meeting-validation.ts <meetingId> [chatId]")
  process.exit(1)
}

async function main() {
  const result = await extractMeetingItemsFlow({
    meetingId,
    chatId,
    sendCard: Boolean(chatId),
    createTasks: true,
    projectToBase: true,
    changedById: "real-meeting-validation",
  })

  console.log(JSON.stringify({
    meetingId: result.meetingId,
    meetingTitle: result.meetingTitle,
    extractedCount: result.extractedCount,
    savedCount: result.savedCount,
    tasksCreated: result.tasksCreated,
    cardMessageId: result.cardMessageId,
    itemIds: result.items.map((item) => item.id),
  }, null, 2))
}

main()
  .finally(async () => {
    await db.shutdown()
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
