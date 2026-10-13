import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Reads a .env file's lines. Returns [] when the file doesn't exist. */
function readLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").split("\n");
}

/**
 * Update or add a single variable in a .env file, preserving all comments and other variables.
 * Pass value=null to remove the variable.
 */
export function setEnvVar(filePath: string, key: string, value: string | null): void {
  const lines = readLines(filePath);
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));

  if (value === null || value === "") {
    if (idx !== -1) lines.splice(idx, 1);
  } else {
    if (idx !== -1) {
      lines[idx] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  // Keep a clean trailing newline
  const content = lines.join("\n").replace(/\n+$/, "") + "\n";
  writeFileSync(filePath, content, "utf8");
}

/** Returns the masked tail of a key for display (e.g. "nvapi-…V7pF"). Never returns the full key. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
