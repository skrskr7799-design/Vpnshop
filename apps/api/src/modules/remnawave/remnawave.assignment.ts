import type { RemnawaveClient } from "./remnawave.client";
import type { RemnawaveUserStatus } from "./remnawave.schemas";

export type PanelUser = {
  id: number;
  username: string;
  marker: string | null;
  status: RemnawaveUserStatus;
  expiresAt: Date;
  deviceLimit: number | null;
  squads: string[];
};

export type AbsoluteProfile = { expiresAt: Date; deviceLimit: number; squads: string[] };

export interface AssignmentPanel {
  instance: string;
  origin: string;
  timeoutMs: number;
  allowedSquads?: readonly string[];
  findUser(username: string): Promise<PanelUser | null>;
  readBack(id: number): Promise<PanelUser | null>;
  createUser(username: string, marker: string, profile: AbsoluteProfile): Promise<void>;
  updateAbsoluteProfile(id: number, profile: AbsoluteProfile): Promise<void>;
  disableUser(id: number): Promise<void>;
  enableUser(id: number): Promise<void>;
  getSubscriptionLink(id: number): Promise<{ user: PanelUser; url: string } | null>;
}

export function assignmentPanel(client: RemnawaveClient, installation: {
  instance: string; origin: string; linkOrigin: string; timeoutMs: number; allowedSquads?: readonly string[];
}): AssignmentPanel {
  type User = NonNullable<Awaited<ReturnType<RemnawaveClient["getUserById"]>>>;
  const normalize = (user: User): PanelUser => ({
    id: user.id, username: user.username, marker: user.description ?? null, status: user.status,
    expiresAt: user.expireAt, deviceLimit: user.hwidDeviceLimit,
    squads: user.activeInternalSquads.map(squad => squad.uuid.toLowerCase()).sort(),
  });
  return {
    instance: installation.instance, origin: installation.origin, timeoutMs: installation.timeoutMs,
    allowedSquads: installation.allowedSquads,
    async findUser(username) {
      const user = await client.getUserByUsername(username);
      return user ? normalize(user) : null;
    },
    async readBack(id) {
      const user = await client.getUserById(id);
      return user ? normalize(user) : null;
    },
    async createUser(username, marker, profile) {
      await client.createUser({ username, description: marker, expireAt: profile.expiresAt,
        hwidDeviceLimit: profile.deviceLimit, activeInternalSquads: profile.squads });
    },
    async updateAbsoluteProfile(id, profile) {
      await client.updateUser({ id, expireAt: profile.expiresAt, hwidDeviceLimit: profile.deviceLimit,
        activeInternalSquads: profile.squads });
    },
    disableUser: id => client.setEnabled(id, false),
    enableUser: id => client.setEnabled(id, true),
    async getSubscriptionLink(id) {
      const user = await client.getUserById(id);
      if (!user) return null;
      const url = new URL(user.subscriptionUrl);
      if (url.protocol !== "https:" || url.origin !== installation.linkOrigin || url.username || url.password) {
        throw new Error("PANEL_LINK_ORIGIN");
      }
      return { user: normalize(user), url: url.href };
    },
  };
}

export function matchesProfile(user: PanelUser, profile: AbsoluteProfile) {
  return user.expiresAt.getTime() === profile.expiresAt.getTime() && user.deviceLimit === profile.deviceLimit &&
    JSON.stringify([...new Set(user.squads)].sort()) === JSON.stringify([...new Set(profile.squads)].sort());
}
