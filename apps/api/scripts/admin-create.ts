// Создаёт админа или повышает существующего пользователя.
//   pnpm --filter @vpn/api admin:create you@example.com            (пароль спросит скрытым вводом)
//   pnpm --filter @vpn/api admin:create you@example.com --support  (роль SUPPORT: только просмотр)
//   echo 'пароль' | pnpm --filter @vpn/api admin:create you@example.com --password-stdin
import { emailField } from "@vpn/shared";
import { createInterface } from "node:readline";
import { prisma } from "../src/lib/prisma";
import { createAdminUser } from "../src/modules/admin/auth/admin-auth.service";

const args = process.argv.slice(2);
const emailArg = args.find((a) => !a.startsWith("--"));
const role = args.includes("--support") ? "SUPPORT" : "ADMIN";

if (!emailArg) {
  console.error("Использование: admin:create <email> [--support] [--password-stdin]");
  process.exit(1);
}
const email = emailField.parse(emailArg);

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const original = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    process.stdout.write(prompt);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {}; // не показываем ввод
    rl.question("", (answer) => {
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = original;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

let password: string;
if (args.includes("--password-stdin")) {
  password = await readStdin();
} else {
  password = await readHidden("Пароль (не короче 12 символов): ");
  if (password !== (await readHidden("Повторите пароль: "))) {
    console.error("Пароли не совпадают");
    process.exit(1);
  }
}

try {
  const result = await createAdminUser({ email, password, role });
  console.log(result.created ? `Создан ${role}: ${email}` : `Пользователь ${email} теперь ${role}, пароль обновлён`);
  console.log("При первом входе админка предложит подключить приложение-аутентификатор (2FA).");
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
