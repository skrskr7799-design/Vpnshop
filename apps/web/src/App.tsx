import { useQuery } from "@tanstack/react-query";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await fetch("/api/health")).json() as Promise<{ status: string }>,
  });

  return (
    <main className="app">
      <h1>VPN Shop</h1>
      <p>API: {health.isPending ? "…" : health.isError ? "недоступен" : health.data.status}</p>
    </main>
  );
}
