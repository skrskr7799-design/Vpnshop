import type { QueryClient } from "@tanstack/react-query";
import { setSessionExpiredHandler } from "../../api/client";
import { meQueryKey } from "./queries";

// Если сессию восстановить не удалось: сбрасываем пользователя и его данные,
// а RequireAuth сам отправит на страницу входа.
export function bindSessionExpiry(queryClient: QueryClient): void {
  setSessionExpiredHandler(() => {
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" });
    queryClient.setQueryData(meQueryKey, null);
  });
}
