/** Authorization is still decided by the Admin API. This metadata also drives command forms. */
const routine = new Set([
  "plan.create", "user.create", "user.activate", "user.registration.activate",
  "user.registration.cancel", "support.reply", "support.action", "settings.update",
]);
const withoutReason = new Set([
  "staff.create", "staff.invite", "user.password.set", "user.password.send_reset",
]);

export function adminCommandPolicy(operation: string, payload: unknown = {}) {
  const draft = operation === "plan.update" && typeof payload === "object" && payload !== null && !("isActive" in payload);
  if (draft || routine.has(operation)) return { stepUp: false, reason: false };
  return { stepUp: true, reason: !withoutReason.has(operation) };
}
