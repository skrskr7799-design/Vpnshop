import { z } from "zod";

export const panelSettings = {
  REMNAWAVE_URL: z.url(),
  REMNAWAVE_TOKEN: z.string().min(1),
  // X-Api-Key, если панель закрыта Caddy с ключами доступа (необязательно)
  REMNAWAVE_API_KEY: z.string().optional().transform(v => v || undefined),
  // Слать x-forwarded-for/proto: нужно, когда API ходит к панели напрямую по внутренней сети
  // (например http://remnawave:3000), мимо её reverse proxy
  REMNAWAVE_TRUSTED_PROXY_HEADERS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Internal squads, в которые попадают новые пользователи (UUID через запятую).
  // Без сквада пользователю, скорее всего, нечего отдавать: проверьте на своей панели.
  REMNAWAVE_INTERNAL_SQUAD_UUIDS: z
    .string()
    .transform((v) => v.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.uuid()).min(1, "at least one internal squad UUID is required")),
};
