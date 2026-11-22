import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bindPrivateSession, resetPrivateRequests } from "../../api/client";
import { authApi, fetchMe, setLogoutHidden } from "./api";

export const meQueryKey = ["auth", "me"] as const;

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: ({ signal }) => fetchMe(signal), staleTime: 0, retry: false, refetchInterval: 30_000 });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    // Положили пользователя в кэш: GuestOnly сам перенаправит на нужную страницу
    onSuccess: ({ user, sessionId }) => {
      setLogoutHidden(false);
      resetPrivateRequests();
      queryClient.removeQueries({ predicate: query => query.queryKey[0] !== "auth" });
      bindPrivateSession(sessionId);
      queryClient.setQueryData(meQueryKey, { ...user, sessionId });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onMutate: () => {
      setLogoutHidden(true);
      resetPrivateRequests();
      void queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "auth" });
      queryClient.setQueryData(meQueryKey, null);
    },
    onSuccess: () => { setLogoutHidden(false); },
  });
}

export const useRegister = () => useMutation({ mutationFn: authApi.register });
export const useVerifyEmail = () => useMutation({ mutationFn: authApi.verifyEmail });
export const useForgotPassword = () => useMutation({ mutationFn: authApi.forgotPassword });
export const useResetPassword = () => useMutation({ mutationFn: authApi.resetPassword });
