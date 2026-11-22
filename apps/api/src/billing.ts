import { runPeriodic } from "./lib/periodic";

// Commerce admission belongs to the provider contract. No real adapter is admitted.
if (process.env.BILLING_MODE !== "disabled") throw new Error("BILLING_MODE must remain disabled");
await runPeriodic("billing", 3003, () => Promise.resolve());
