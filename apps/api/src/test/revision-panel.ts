import { vi } from "vitest";
import type { AbsoluteProfile, AssignmentPanel, PanelUser } from "../modules/remnawave/remnawave.assignment";
import { RemnawaveError } from "../modules/remnawave/remnawave.errors";

export const secret = "https://links.example.invalid/sub/private-credential";

export function mockPanel() {
  let remote: PanelUser | null = null;
  const setProfile = (profile: AbsoluteProfile) => {
    if (!remote) throw new Error("Missing fixture");
    remote = { ...remote, ...profile, status: remote.status === "DISABLED" ? "DISABLED" : "ACTIVE" };
  };
  const panel = {
    instance: "staging-test", origin: "https://panel.example.invalid", timeoutMs: 20,
    findUser: vi.fn(async (_username: string) => remote && structuredClone(remote)),
    readBack: vi.fn(async (_id: number) => remote && structuredClone(remote)),
    createUser: vi.fn(async (username: string, marker: string, profile: AbsoluteProfile) => {
      if (remote) throw new RemnawaveError("rejected", 400, "Duplicate", "A019");
      remote = { id: 922, username, marker, status: "ACTIVE", ...profile };
    }),
    updateAbsoluteProfile: vi.fn(async (_id: number, profile: AbsoluteProfile) => setProfile(profile)),
    disableUser: vi.fn(async (_id: number) => { remote!.status = "DISABLED"; }),
    enableUser: vi.fn(async (_id: number) => { remote!.status = "ACTIVE"; }),
    getSubscriptionLink: vi.fn(async (_id: number) => remote && { user: structuredClone(remote), url: secret }),
  } satisfies AssignmentPanel;
  return { panel, setProfile, get current() { return remote; }, change(user: PanelUser | null) { remote = user; } };
}
