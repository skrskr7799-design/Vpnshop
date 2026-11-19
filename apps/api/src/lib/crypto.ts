import { createHash, randomBytes } from "node:crypto";

// Случайный токен с 256 бит энтропии. В БД храним только sha256-хэш.
export const generateToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

// Для токенов с высокой энтропией быстрого sha256 достаточно (медленный KDF нужен только паролям).
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
