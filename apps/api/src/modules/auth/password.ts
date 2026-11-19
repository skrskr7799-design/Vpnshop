import { hash, verify } from "@node-rs/argon2";
import { generateToken } from "../../lib/crypto";

// argon2id, параметры по минимуму OWASP: 19 MiB памяти, 2 прохода, 1 поток.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (plain: string): Promise<string> => hash(plain, OPTIONS);

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

// Хэш-пустышка: при входе с несуществующим email делаем такую же работу,
// чтобы время ответа не выдавало, есть ли аккаунт.
const dummyHash = hashPassword(generateToken());

export async function verifyAgainstDummy(plain: string): Promise<void> {
  await verifyPassword(await dummyHash, plain);
}
