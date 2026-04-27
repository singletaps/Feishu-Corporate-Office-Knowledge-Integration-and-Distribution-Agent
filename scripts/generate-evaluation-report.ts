import { runEvaluationReport } from "../src/evaluation/eval-runner.js"
import { db } from "../src/shared/db.js"

const outputPath = process.argv[2] ?? "效果验证报告.md"

runEvaluationReport(outputPath)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2))
    return db.shutdown()
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
