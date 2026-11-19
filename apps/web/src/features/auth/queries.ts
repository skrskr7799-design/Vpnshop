import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authApi, fetchMe } from "./api";

export const meQueryKey = ["auth", "me"] as const;

export function useMe() {
  return useQuery({ queryKey: meQueryKey, queryFn: fetchMe, staleTime: 5 * 60 * 1000 });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    // Положили пользователя в кэш: GuestOnly сам перенаправит на нужную страницу
    onSuccess: ({ user }) => queryClient.setQueryData(meQueryKey, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    // Даже если запрос не дошёл, локально выходим и чистим данные прошлого пользователя
    onSettled: () => {
      queryClient.clear();
      queryClient.setQueryData(meQueryKey, null);
    },
  });
}

export const useRegister = () => useMutation({ mutationFn: authApi.register });
export const useVerifyEmail = () => useMutation({ mutationFn: authApi.verifyEmail });
export const useForgotPassword = () => useMutation({ mutationFn: authApi.forgotPassword });
export const useResetPassword = () => useMutation({ mutationFn: authApi.resetPassword });
