import { BACKOFF_BASE_MS, BACKOFF_MAX_MS } from "./fulfillment.constants";

// Экспоненциальная пауза с разбросом ±20%, чтобы повторы не сходились в одну секунду
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}
