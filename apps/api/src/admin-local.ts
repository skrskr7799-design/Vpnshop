import { z } from "zod";
import { Prisma } from "@prisma/client";
import { env } from "./config/env";
import { AppError } from "./lib/errors";
import { prisma } from "./lib/prisma";
import { adoptInput, adoptLegacyOwner, bootstrapInput, bootstrapOwner, listLocalStaff, recoverInput, recoverOwner } from "./modules/admin/auth/local-admin";

try {
  const operation = process.argv[2];
  if (env.MZT_PROCESS !== "admin" || process.argv.length !== 3) throw new AppError(403, "LOCAL_ADMIN_ONLY");
  if (operation === "list") {
    console.log(JSON.stringify(await listLocalStaff()));
  } else {
    let body = "";
    for await (const chunk of process.stdin.setEncoding("utf8")) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) throw new AppError(400, "INVALID_LOCAL_INPUT");
    }
    const input: unknown = JSON.parse(body);
    const result = operation === "bootstrap" ? await bootstrapOwner(bootstrapInput.parse(input))
      : operation === "recover" ? await recoverOwner(recoverInput.parse(input))
      : operation === "adopt-legacy-owner" ? await adoptLegacyOwner(adoptInput.parse(input)) : null;
    if (!result) throw new AppError(400, "INVALID_LOCAL_OPERATION");
    console.log(JSON.stringify(result));
  }
} catch (error) {
  // Neither parse details nor a Prisma exception may contain credential material in operator logs.
  const code = error instanceof AppError ? error.code
    : error instanceof Prisma.PrismaClientKnownRequestError && /^P[0-9]{4}$/.test(error.code) ? "LOCAL_ADMIN_DB_" + error.code
    : (error instanceof SyntaxError || error instanceof z.ZodError) ? "INVALID_LOCAL_INPUT" : "LOCAL_ADMIN_COMMAND_FAILED";
  console.error(code);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
