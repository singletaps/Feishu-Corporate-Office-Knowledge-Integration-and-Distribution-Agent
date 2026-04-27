import { execFile } from "node:child_process"
import { writeFileSync, unlinkSync } from "node:fs"

const BASE_TOKEN = "XRkEb3CNjaGxx8shAAPcGMywn9d"
const TABLE_ID = "tblfJdoPHoXLjSEw"
const LARK_CLI = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli"

const fields = [
  { name: "事项标题", type: "text" },
  {
    name: "事项类型",
    type: "select",
    multiple: false,
    options: [
      { name: "todo", hue: "Blue", lightness: "Lighter" },
      { name: "decision", hue: "Purple", lightness: "Lighter" },
      { name: "risk", hue: "Orange", lightness: "Lighter" },
      { name: "blocker", hue: "Red", lightness: "Lighter" },
    ],
  },
  {
    name: "状态",
    type: "select",
    multiple: false,
    options: [
      { name: "new", hue: "Gray", lightness: "Lighter" },
      { name: "pending_review", hue: "Orange", lightness: "Lighter" },
      { name: "active", hue: "Blue", lightness: "Lighter" },
      { name: "blocked", hue: "Red", lightness: "Lighter" },
      { name: "done", hue: "Green", lightness: "Lighter" },
      { name: "closed", hue: "Gray", lightness: "Light" },
    ],
  },
  {
    name: "优先级",
    type: "select",
    multiple: false,
    options: [
      { name: "low", hue: "Gray", lightness: "Lighter" },
      { name: "medium", hue: "Blue", lightness: "Lighter" },
      { name: "high", hue: "Orange", lightness: "Lighter" },
      { name: "critical", hue: "Red", lightness: "Lighter" },
    ],
  },
  { name: "负责人", type: "user", multiple: false },
  { name: "负责人ID", type: "text" },
  { name: "截止时间", type: "datetime" },
  { name: "置信度", type: "number" },
  { name: "来源类型", type: "text" },
  { name: "来源ID", type: "text" },
  { name: "飞书任务ID", type: "text" },
  { name: "WorkItem ID", type: "text" },
]

function run(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(LARK_CLI, args, { maxBuffer: 10 * 1024 * 1024, shell: process.platform === "win32" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(JSON.parse(stdout))
    })
  })
}

async function main() {
  const current = await run([
    "base", "+field-list",
    "--as", "user",
    "--base-token", BASE_TOKEN,
    "--table-id", TABLE_ID,
    "--limit", "100",
  ])

  const existingNames = new Set<string>(current.data.fields.map((field: { name: string }) => field.name))

  for (const [index, field] of fields.entries()) {
    if (existingNames.has(field.name)) {
      console.log(`skip existing field: ${field.name}`)
      continue
    }

    const file = `./field-${index}.json`
    writeFileSync(file, JSON.stringify(field), "utf-8")

    console.log(`creating field: ${field.name}`)
    await run([
      "base", "+field-create",
      "--as", "user",
      "--base-token", BASE_TOKEN,
      "--table-id", TABLE_ID,
      "--json", `@${file}`,
    ])

    unlinkSync(file)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
