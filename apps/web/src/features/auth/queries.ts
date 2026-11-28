import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/ApiError";
import { bindPrivateSession, resetPrivateRequests } from "../../api/client";
import { authApi, fetchMe, publishSessionEvent, setLogoutHidden } from "./api";

import { loadDashboard, loginMutationKey, rememberEntryMethod } from "./entry";

export const meQueryKey = ["auth", "me"] as const;

export function clearAccountCache(queryClient: QueryClient) {
  resetPrivateRequests();
  void queryClient.cancelQueries();
  queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "auth" });
  queryClient.setQueryData(meQueryKey, null);
}

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: ({ signal }) => fetchMe(signal), staleTime: 0, retry: false, refetchInterval: 30_000 });
}

export function useLogin(onEntry: () => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: loginMutationKey,
    mutationFn: async (input: Parameters<typeof authApi.login>[0]) => {
      const { sessionId } = await authApi.login(input);
      setLogoutHidden(false);
      const confirmed = await fetchMe();
      if (!confirmed || confirmed.sessionId !== sessionId) throw new ApiError(401, "UNAUTHENTICATED");
      rememberEntryMethod("email");
      const ready = await loadDashboard().then(() => true, () => false);
      if (ready) await onEntry();
      return confirmed;
    },
    onSuccess: user => {
      resetPrivateRequests();
      queryClient.removeQueries({ predicate: query => query.queryKey[0] !== "auth" });
      bindPrivateSession(user.sessionId);
      queryClient.setQueryData(meQueryKey, user);
      publishSessionEvent("login");
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onMutate: () => {
      setLogoutHidden(true);
      clearAccountCache(queryClient);
      publishSessionEvent("logout-started");
    },
    onSuccess: () => { setLogoutHidden(false); publishSessionEvent("logout-confirmed"); },
  });
}

export const useRegister = () => useMutation({ mutationFn: authApi.register });
export const useVerifyEmail = () => useMutation({ mutationFn: authApi.verifyEmail });
export const useForgotPassword = () => useMutation({ mutationFn: authApi.forgotPassword });
export const useResetPassword = () => useMutation({ mutationFn: authApi.resetPassword });
