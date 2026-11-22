// Read-only проверка связи с панелью Remnawave: ничего не создаёт и не меняет.
// Запуск: pnpm --filter @vpn/api remnawave:check
import { z } from "zod";
import { panelSettings } from "../src/config/panel-env";
const env = z.object(panelSettings).parse(process.env);
import { SUPPORTED_PANEL_SERIES } from "../src/modules/remnawave/remnawave.compat";
import { RemnawaveError } from "../src/modules/remnawave/remnawave.errors";
import { remnawave } from "../src/modules/remnawave";

let failed = false;
const ok = (msg: string) => console.log(`  ok    ${msg}`);
const warn = (msg: string) => console.log(`  warn  ${msg}`);
const fail = (msg: string) => {
  failed = true;
  console.log(`  FAIL  ${msg}`);
};

console.log(`Панель: ${env.REMNAWAVE_URL}`);

try {
  const { version } = await remnawave.getMetadata();
  const series = version.split(".").slice(0, 2).join(".");
  if (series === SUPPORTED_PANEL_SERIES) ok(`версия панели ${version} (клиент написан под ${SUPPORTED_PANEL_SERIES}.x)`);
  else warn(`версия панели ${version}, клиент написан под ${SUPPORTED_PANEL_SERIES}.x: сверьте схемы с контрактом`);
} catch (err) {
  fail(`метаданные: ${err instanceof Error ? err.message : err}`);
  if (err instanceof RemnawaveError && err.kind === "unauthorized") {
    console.log("        Проверьте REMNAWAVE_TOKEN (Panel -> API Tokens) и, если панель за Caddy, REMNAWAVE_API_KEY.");
  }
}

try {
  const squads = await remnawave.listInternalSquads();
  const known = new Set(squads.map((s) => s.uuid));
  ok(`internal squads в панели: ${squads.map((s) => `${s.name} (${s.uuid})`).join(", ") || "нет"}`);
  for (const uuid of env.REMNAWAVE_INTERNAL_SQUAD_UUIDS) {
    if (known.has(uuid)) ok(`настроенный сквад найден: ${uuid}`);
    else fail(`настроенный сквад НЕ найден в панели: ${uuid}`);
  }
} catch (err) {
  fail(`internal squads: ${err instanceof Error ? err.message : err}`);
}

try {
  const missing = await remnawave.getUserByUsername("vs_check_does_not_exist");
  if (missing === null) ok("запрос несуществующего пользователя возвращает 404 (как ожидает клиент)");
  else warn("несуществующий пользователь неожиданно найден");
} catch (err) {
  fail(`поиск пользователя: ${err instanceof Error ? err.message : err}`);
}

process.exit(failed ? 1 : 0);
