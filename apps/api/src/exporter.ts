import { runPeriodic } from "./lib/periodic";

await runPeriodic("exporter", 3005, () => Promise.resolve());
