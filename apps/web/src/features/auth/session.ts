import type { QueryClient } from "@tanstack/react-query";
import { setSessionExpiredHandler } from "../../api/client";
import { onSessionEvent, setLogoutHidden } from "./api";
import { clearAccountCache, meQueryKey } from "./queries";

export function bindSessionExpiry(queryClient: QueryClient): void {
  setSessionExpiredHandler(() => clearAccountCache(queryClient));
  onSessionEvent(event => {
    setLogoutHidden(event === "logout-started");
    if (event !== "logout-confirmed") clearAccountCache(queryClient);
    if (event === "login") void queryClient.invalidateQueries({ queryKey: meQueryKey });
  });
}
