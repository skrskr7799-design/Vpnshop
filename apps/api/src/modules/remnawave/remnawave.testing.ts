import { PANEL_USER } from "./remnawave.fixtures";
import { RemnawaveError } from "./remnawave.errors";
import type { RemnawaveApi } from "./remnawave.provisioning";
import { remnawaveUserSchema, type RemnawaveUser } from "./remnawave.schemas";

// «Панель» в памяти для тестов воркера: хранит пользователей, считает вызовы,
// умеет «падать» (недоступна / неверный токен).
export function createFakePanel() {
  const users = new Map<string, RemnawaveUser>();
  const calls = { get: 0, create: 0, update: 0 };
  let nextId = 100;
  let down: RemnawaveError | null = null;

  const build = (username: string, over: Partial<Record<string, unknown>>): RemnawaveUser =>
    remnawaveUserSchema.parse({ ...PANEL_USER, id: nextId++, username, ...over });

  const guard = () => {
    if (down) throw down;
  };

  const api: RemnawaveApi = {
    async getUserByUsername(username) {
      calls.get++;
      guard();
      return users.get(username) ?? null;
    },
    async createUser(input) {
      calls.create++;
      guard();
      if (users.has(input.username)) throw new RemnawaveError("rejected", 400, "username already exists");
      const user = build(input.username, {
        expireAt: input.expireAt.toISOString(),
        hwidDeviceLimit: input.hwidDeviceLimit,
        status: "ACTIVE",
      });
      users.set(input.username, user);
      return user;
    },
    async updateUser(input) {
      calls.update++;
      guard();
      const entry = [...users.entries()].find(([, u]) => u.id === input.id);
      if (!entry) throw new RemnawaveError("not_found", 404, "user not found");
      const updated: RemnawaveUser = {
        ...entry[1],
        ...(input.expireAt && { expireAt: input.expireAt }),
        ...(input.status && { status: input.status }),
        ...(input.hwidDeviceLimit !== undefined && { hwidDeviceLimit: input.hwidDeviceLimit }),
      };
      users.set(entry[0], updated);
      return updated;
    },
  };

  return {
    api,
    calls,
    users,
    setDown(error: RemnawaveError | null) {
      down = error;
    },
    seed(username: string, over: { expireAt: Date; status?: RemnawaveUser["status"] }) {
      const user = build(username, { expireAt: over.expireAt.toISOString(), status: over.status ?? "ACTIVE" });
      users.set(username, user);
      return user;
    },
    get(username: string) {
      return users.get(username);
    },
  };
}
