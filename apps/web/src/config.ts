import { useQuery } from "@tanstack/react-query";
import { publicProductConfig } from "@vpn/shared";

export function useProductConfig() {
  return useQuery({
    queryKey: ["product-config"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/config", { signal, cache: "no-store", credentials: "omit" });
      if (response.status === 404) return null; // Previous Core during a rolling upgrade.
      if (!response.ok) throw new Error("Product configuration is unavailable");
      return publicProductConfig.parse(await response.json());
    },
    retry: false, staleTime: 15_000, refetchInterval: 30_000,
  });
}
