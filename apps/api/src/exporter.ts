import { readFile, statfs } from "node:fs/promises";
import { startMetrics } from "./lib/telemetry";
import { prisma } from "./lib/prisma";

const flags = new Set(["backup_on", "panel_on"]);
const proofDirectory = "/state/proofs";
const time = () => Date.now() / 1000;
async function readValue(name: string) {
  const content = await readFile(`${proofDirectory}/${name}`, "utf8").catch(() => "");
  if (!/^[0-9]{1,12}\s*$/.test(content)) return -1;
  const value = Number(content);
  return flags.has(name) ? value : Math.max(-1, time() - value);
}
const safeRecord = (name: string, value: string | number | bigint) => `mzt_${name} ${value}`;

async function collect() {
  let database: Record<string, string | number | bigint> | undefined;
  try { [database] = await prisma.$queryRaw<Record<string, string | number | bigint>[]>`SELECT * FROM mzt_operational_metrics`; }
  catch { /* Availability is itself a signal. */ }
  const volume = await statfs(proofDirectory).catch(() => null);
  return [
    safeRecord("postgres_up", database ? 1 : 0),
    ...Object.entries(database ?? {}).map(([name, value]) => safeRecord(name, value)),
    safeRecord("disk_used_ratio", volume?.blocks ? 1 - volume.bavail / volume.blocks : -1),
    safeRecord("backup_enabled", process.env.BACKUP_MONITOR === "true" ? 1 : 0),
    safeRecord("panel_enabled", process.env.PANEL_MONITOR === "true" ? 1 : 0),
    safeRecord("backup_age_seconds", await readValue("physical_epoch")),
    safeRecord("logical_backup_age_seconds", await readValue("logical_epoch")),
    safeRecord("restore_verification_age_seconds", await readValue("restore_epoch")),
  ].join("\n") + "\n";
}
if (!process.env.METRICS_HOST) throw new Error("Exporter requires the monitoring network address");
await startMetrics(collect);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void prisma.$disconnect(); });
