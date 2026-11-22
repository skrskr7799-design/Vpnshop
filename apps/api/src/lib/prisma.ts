import { PrismaClient } from "@prisma/client";

import { readSecret } from "../config/secrets";

const datasourceUrl = readSecret("DATABASE_URL");
export const prisma = new PrismaClient({ datasourceUrl });
