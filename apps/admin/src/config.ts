import { useQuery } from "@tanstack/react-query";
import { publicProductMetadata } from "@vpn/shared";

export function useProductBrand() {
  const { data } = useQuery({
    queryKey: ["brand"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/config", { signal, cache: "no-store", credentials: "omit" });
      return response.ok ? publicProductMetadata.parse(await response.json()).product.brandName : "MZT";
    },
    retry: false, staleTime: 30_000,
  });
  return data ?? "MZT";
}
