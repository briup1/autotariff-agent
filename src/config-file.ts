import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads the flat `key: value` files in config/. Only scalars and comments are supported.
 * Anything else fails loudly: a budget that is silently misread is worse than a crash.
 */
export function readFlatConfig(path: string): Record<string, string | number> {
  if (!existsSync(path)) throw new Error(`Missing config file: ${path}`);
  const out: Record<string, string | number> = {};
  for (const [index, raw] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!match) throw new Error(`${path}:${index + 1} is not a flat "key: value" line: ${raw}`);
    const [, key, value] = match;
    if (!value) throw new Error(`${path}:${index + 1} has no value for ${key}`);
    if (key in out) throw new Error(`${path}:${index + 1} repeats ${key}`);
    out[key] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

export function requireString(config: Record<string, string | number>, key: string, path: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${path} must declare ${key} as text`);
  return value;
}

export function optionalInteger(config: Record<string, string | number>, key: string, path: string): number | undefined {
  if (!(key in config)) return undefined;
  const value = config[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`${path} must declare ${key} as a positive integer`);
  return value;
}

export function resolveFrom(root: string, path: string): string {
  return resolve(root, path);
}
