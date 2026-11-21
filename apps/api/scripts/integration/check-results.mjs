import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const files = readdirSync("src", { recursive: true }).filter(name => name.endsWith(".int.test.ts"));
for (const result of report.testResults) {
  for (const test of result.assertionResults) {
    if (test.status === "failed" && process.env.GITHUB_ACTIONS) {
      console.error(`::error file=${result.name}::Integration assertion failed: ${test.fullName}`);
      if (result.name.endsWith("/payments.int.test.ts")) {
        const details = stripVTControlCharacters((test.failureMessages ?? []).join("\n"))
          .replace(/(?:postgres(?:ql)?:\/\/)[^\s"']+/gi, "[database url]")
          .split("\n").filter(line => line.trim() && !line.startsWith("    at ")).slice(0, 8)
          .join("%0A").slice(0, 600);
        console.error(`::error file=${result.name}::${details}`);
      }
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
