import { readFileSync } from "node:fs";

export function readSecret(name: string, source = process.env): string | undefined {
  const filepath = source[name + "_FILE"];
  if (!filepath) return source[name] || undefined;
  if (source[name]) throw new Error("Ambiguous secret configuration: " + name);
  if (!/^\/run\/secrets\/[a-zA-Z0-9_.-]+$/.test(filepath)) throw new Error("Invalid secret path: " + name);
  let value: string;
  try { value = readFileSync(filepath, "utf8").trimEnd(); }
  catch { throw new Error("Cannot read secret: " + name); }
  if (!value || value.includes("\0") || value.includes("\n") || value.length > 16384) {
    throw new Error("Invalid secret: " + name);
  }
  return value;
}
