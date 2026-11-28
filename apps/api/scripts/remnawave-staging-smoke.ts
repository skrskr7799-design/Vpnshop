import { randomBytes, randomUUID } from "node:crypto";
import { stagingPanel } from "../src/config/staging-panel";
import { matchesProfile } from "../src/modules/remnawave/remnawave.assignment";

async function smoke() {
  const [execution, rotation, ...extra] = process.argv.slice(2);
  if (execution !== "--execute-isolated" || (rotation && rotation !== "--check-link-rotation") || extra.length) {
    throw new Error("Explicit isolated staging execution required");
  }
  const staging = stagingPanel(10_000);
  if (!staging) throw new Error("Staging mode required");
  const { panel, client, squads } = staging;
  const metadata = await client.getMetadata();
  if (metadata.version !== "3.4.9") throw new Error("Unsupported staging version");
  const known = await client.listInternalSquads();
  if (squads.some(id => !known.some(squad => squad.uuid.toLowerCase() === id))) throw new Error("Unknown staging squad");

  async function inspectLink(url: string) {
    // URLs are already origin-validated by assignmentPanel. Never log the URL/body,
    // accept cross-origin redirects or forward the management token to the subscription host.
    const response = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(panel.timeoutMs) });
    await response.body?.cancel();
    return response.status;
  }
  const username = `stg_${randomUUID().replaceAll("-", "")}`;
  const marker = `vpnshop:${panel.instance}:smoke:${randomUUID()}`;
  if (await panel.findUser(username)) throw new Error("Smoke username is occupied");
  let boundId: number | undefined;
  const belongs = (user: Awaited<ReturnType<typeof panel.findUser>>) =>
    user && user.username === username && user.marker === marker && Number.isSafeInteger(user.id) &&
    (boundId === undefined || user.id === boundId) ? user : null;
  async function cleanup() {
    const owned = belongs(boundId === undefined ? await panel.findUser(username) : await panel.readBack(boundId));
    if (!owned) throw new Error("Smoke cleanup requires manual identity review");
    if (owned.status !== "DISABLED") await panel.disableUser(owned.id);
    if (belongs(await panel.readBack(owned.id))?.status !== "DISABLED") throw new Error("Smoke cleanup needs review");
    console.log(`Isolated smoke user retained disabled: ${username}`);
  }
  const profile = { expiresAt: new Date(Date.now() + 60 * 60_000), deviceLimit: 2, squads };
  try {
    await panel.createUser(username, marker, profile);
    const user = belongs(await panel.findUser(username));
    if (!user || !matchesProfile(user, profile)) throw new Error("Staging create mismatch");
    boundId = user.id;
    const replacement = { ...profile, expiresAt: new Date(profile.expiresAt.getTime() + 60 * 60_000), deviceLimit: 3 };
    await panel.updateAbsoluteProfile(user.id, replacement);
    await panel.updateAbsoluteProfile(user.id, replacement);
    const updated = belongs(await panel.readBack(user.id));
    if (!updated || !matchesProfile(updated, replacement)) throw new Error("Staging profile mismatch");
    await panel.disableUser(user.id);
    if (belongs(await panel.readBack(user.id))?.status !== "DISABLED") throw new Error("Staging disable mismatch");
    await panel.enableUser(user.id);
    if (belongs(await panel.readBack(user.id))?.status !== "ACTIVE") throw new Error("Staging enable mismatch");
    const link = await panel.getSubscriptionLink(user.id);
    if (!link || !belongs(link.user)) throw new Error("Staging link mismatch");
    if (rotation) {
      const before = await client.getUserById(user.id);
      if (!before || !belongs(link.user) || before.username !== username || before.description !== marker ||
          await inspectLink(link.url) !== 200) throw new Error("Staging link was not usable before rotation");

      // Persisted local application state would store only a digest of this value.
      // The probe confirms by a fresh read, independently of the mutation's response.
      const replacement = randomBytes(24).toString("base64url");
      await client.revokeSubscriptionForStaging(user.id, replacement).catch(() => undefined);
      const after = await client.getUserById(user.id);
      const freshLink = await panel.getSubscriptionLink(user.id);
      if (!after || after.shortUuid !== replacement || before.shortUuid === after.shortUuid ||
          !freshLink || !belongs(freshLink.user) || !matchesProfile(freshLink.user, updated) ||
          freshLink.user.status !== "ACTIVE" || freshLink.url === link.url) {
        throw new Error("Staging link rotation could not be confirmed");
      }
      const oldStatus = await inspectLink(link.url);
      if ((oldStatus !== 404 && oldStatus !== 410) || await inspectLink(freshLink.url) !== 200) {
        throw new Error("Staging old/new link acceptance check failed");
      }
      console.log("Isolated rotation: old subscription link rejected and new link usable");
    }
  } finally {
    await cleanup();
  }
  console.log(`Remnawave ${metadata.version}: isolated transport smoke passed`);
}

await smoke().catch(() => {
  console.error("Isolated smoke failed. Inspect only smoke users bearing the staging marker.");
  process.exitCode = 1;
});
