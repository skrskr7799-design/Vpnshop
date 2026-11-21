// Сброс второго фактора админа (потеряны и телефон, и резервные коды).
// Все его сессии закрываются, при следующем входе 2FA подключается заново.
//   pnpm --filter @vpn/api admin:reset-2fa you@example.com
import { emailField } from "@vpn/shared";
import { prisma } from "../src/lib/prisma";
import { resetAdminTotp } from "../src/modules/admin/auth/admin-auth.service";

const emailArg = process.argv[2];
if (!emailArg) {
  console.error("Использование: admin:reset-2fa <email>");
  process.exit(1);
}

try {
  const found = await resetAdminTotp(emailField.parse(emailArg));
  console.log(found ? "2FA сброшена, сессии закрыты." : "Пользователь не найден.");
  process.exitCode = found ? 0 : 1;
} finally {
  await prisma.$disconnect();
}
