import type { Logger } from "../../lib/log";
import type { RemnawaveClient } from "./remnawave.client";

// Серия панели, под которую написан и протестирован клиент (официальный контракт 3.4.17 = панель 3.4.x)
export const SUPPORTED_PANEL_SERIES = "3.4";

// Проверка при старте. Ничего не роняет: панель может быть временно недоступна,
// а API магазина должен подняться. Только предупреждает в логах.
export async function checkPanelCompatibility(
  client: Pick<RemnawaveClient, "getMetadata" | "listInternalSquads">,
  log: Logger,
  internalSquadUuids: string[],
): Promise<void> {
  try {
    const { version } = await client.getMetadata();
    const series = version.split(".").slice(0, 2).join(".");
    if (series === SUPPORTED_PANEL_SERIES) {
      log.info({ version }, "Remnawave: версия панели совместима");
    } else {
      log.warn(
        { version, supported: `${SUPPORTED_PANEL_SERIES}.x` },
        "Remnawave: версия панели отличается от той, под которую написан клиент. Сверьте схемы с контрактом",
      );
    }

    const known = new Set((await client.listInternalSquads()).map((s) => s.uuid));
    const missing = internalSquadUuids.filter((uuid) => !known.has(uuid));
    if (missing.length > 0) {
      log.error({ missing }, "Remnawave: настроенные internal squads не найдены в панели");
    }
  } catch (err) {
    log.warn({ err }, "Remnawave: не удалось проверить панель при старте");
  }
}
