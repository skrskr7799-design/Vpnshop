import { mazeOpeningMs } from "@vpn/ui";
import type { OAuthProviderId } from "@vpn/shared";

export const loginMutationKey = ["auth", "login"] as const;
export const oauthMethodParam = "signed-in-with";
type EntryMethod = OAuthProviderId | "email";
const storageKey = "mzt.last-sign-in-method";
let lastMethod: EntryMethod | undefined;

export function readEntryMethod(): EntryMethod | undefined {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "email" || value === "google" || value === "telegram") return value;
  } catch { /* Browser storage is optional. */ }
  return lastMethod;
}

export function rememberEntryMethod(method: EntryMethod) {
  lastMethod = method;
  try { localStorage.setItem(storageKey, method); } catch { /* Browser storage is optional. */ }
}

export function loadDashboard() {
  return import("../account/CommercePages");
}

const motionKey = "mzt.reduce-motion";

export function motionDisabled() {
  try { return localStorage.getItem(motionKey) === "1"; } catch { return false; }
}

export function setMotionDisabled(disabled: boolean) {
  try {
    if (disabled) localStorage.setItem(motionKey, "1");
    else localStorage.removeItem(motionKey);
  } catch { /* Browser storage is optional. */ }
  document.documentElement.toggleAttribute("data-mzt-reduce-motion", disabled);
}

export async function playEntry(show: () => void, signal?: AbortSignal) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (motion.matches || document.documentElement.hasAttribute("data-mzt-reduce-motion") || document.hidden || signal?.aborted) return;

  show();
  await new Promise<void>(resolve => {
    const timer = window.setTimeout(finish, mazeOpeningMs);

    function finish() {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", finish);
      motion.removeEventListener("change", finish);
      signal?.removeEventListener("abort", finish);
      resolve();
    }

    document.addEventListener("visibilitychange", finish);
    motion.addEventListener("change", finish);
    signal?.addEventListener("abort", finish);
  });
}
