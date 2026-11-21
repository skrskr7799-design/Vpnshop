import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const files = readdirSync("src", { recursive: true }).filter(name => name.endsWith(".int.test.ts"));
for (const result of report.testResults) {
  for (const test of result.assertionResults) {
    if (test.status === "failed" && process.env.GITHUB_ACTIONS) {
      console.error(`::error file=${result.name}::Integration assertion failed: ${test.fullName}`);
    }
  }
}
if (!files.length || !report.success) throw new Error("No successful integration suite");
for (const file of files) {
  const suite = report.testResults.find(result => result.name === resolve("src", file));
  if (!suite?.assertionResults.length || suite.assertionResults.some(test => test.status !== "passed")) {
    throw new Error(`Missing, skipped or unsuccessful integration tests in ${file}`);
  }
}
console.log(`PostgreSQL integration: ${files.length} files, ${report.numPassedTests} passed`);
