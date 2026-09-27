import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEntry } from "../../../packages/contracts/src/api";

/** What a caller supplies. The log assigns `id`, `prevHash` and `hash`. */
export type NewAuditEntry = Omit<AuditEntry, "id" | "prevHash" | "hash">;

export const GENESIS_HASH = "0".repeat(64);
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

export type ChainCheck =
  | { ok: true; entries: number }
  | { ok: false; entries: number; brokenAt: number; reason: string };

/** JSON with sorted keys, so the same content always hashes the same way (also after a round trip through a file). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    const fields = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  return createHash("sha256").update(canonical(entry)).digest("hex");
}

/**
 * Checks that ids run 1..n, every entry links to the one before it, and every entry's contents match its hash.
 * Changing, removing, adding or reordering an entry anywhere but the very end is detected. Cutting entries off
 * the end is not: that needs the latest hash kept somewhere else.
 */
export function verifyChain(entries: readonly AuditEntry[]): ChainCheck {
  let previous = GENESIS_HASH;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const broken = (reason: string): ChainCheck => ({ ok: false, entries: entries.length, brokenAt: index + 1, reason });
    if (entry.id !== index + 1) return broken(`expected entry ${index + 1} but found ${entry.id} (an entry was removed, added or reordered)`);
    if (entry.prevHash !== previous) return broken("it does not link to the entry before it");
    const { hash, ...contents } = entry;
    if (hash !== hashEntry(contents)) return broken("its contents do not match its recorded hash (it was altered)");
    previous = entry.hash;
  }
  return { ok: true, entries: entries.length };
}

export interface AuditLoad {
  entries: AuditEntry[];
  /** Things wrong with what was read, such as a line that is not valid JSON. */
  problems: string[];
}

export interface AuditSinkHealth {
  writable: boolean;
  detail: string | null;
}

/** Where entries are kept. Swap the implementation (a database, say) without touching the orchestrator. */
export interface AuditSink {
  readonly kind: "memory" | "file";
  readonly location?: string;
  load(): AuditLoad;
  /** Persists one entry. Throws if it cannot. */
  append(entry: AuditEntry): void;
  health(): AuditSinkHealth;
}

export class MemoryAuditSink implements AuditSink {
  readonly kind = "memory" as const;
  load(): AuditLoad {
    return { entries: [], problems: [] };
  }
  append(): void {}
  health(): AuditSinkHealth {
    return { writable: true, detail: null };
  }
}

/** One JSON entry per line, appended. Nothing is ever rewritten. */
export class FileAuditSink implements AuditSink {
  readonly kind = "file" as const;
  private needsNewline = false;

  constructor(readonly location: string) {}

  load(): AuditLoad {
    if (!existsSync(this.location)) return { entries: [], problems: [] };
    const text = readFileSync(this.location, "utf8");
    // A crash mid-write can leave a last line with no newline; the next entry must not be glued onto it.
    this.needsNewline = text.length > 0 && !text.endsWith("\n");
    const entries: AuditEntry[] = [];
    const problems: string[] = [];
    text.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        problems.push(`line ${index + 1} is not valid JSON`);
      }
    });
    return { entries, problems };
  }

  append(entry: AuditEntry): void {
    mkdirSync(dirname(this.location), { recursive: true });
    appendFileSync(this.location, `${this.needsNewline ? "\n" : ""}${JSON.stringify(entry)}\n`);
    this.needsNewline = false;
  }

  health(): AuditSinkHealth {
    try {
      mkdirSync(dirname(this.location), { recursive: true });
      accessSync(existsSync(this.location) ? this.location : dirname(this.location), constants.W_OK);
      return { writable: true, detail: null };
    } catch (error) {
      return { writable: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

export interface AuditQuery {
  taskId?: string;
  type?: string;
  actor?: string;
  /** ISO timestamps, inclusive. */
  since?: string;
  until?: string;
  /** Default "desc" (newest first). */
  order?: "asc" | "desc";
  /** The id of the last entry of the previous page. */
  cursor?: number | null;
  limit?: number;
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  nextCursor: number | null;
  total: number;
}

export interface AuditHealth {
  storage: "memory" | "file";
  location: string | null;
  entries: number;
  /** Entries recorded but not yet written, because the sink was failing. */
  pending: number;
  writable: boolean;
  lastError: string | null;
  integrity: ChainCheck;
}

/**
 * The append-only, hash-chained record of every decision. `record` never throws: a failing sink must not break
 * the orchestrator. Entries stay readable from memory, are held until the sink recovers, and are then written
 * in order, so the file never has a gap.
 */
export class AuditLog {
  private readonly entries: AuditEntry[];
  private persisted: number;
  private lastHash: string;
  private lastError: string | null = null;
  private readonly integrity: ChainCheck;
  /** Set when the existing file could not be read: writing to it would corrupt it. */
  private readonly blocked: string | null;

  constructor(private readonly sink: AuditSink = new MemoryAuditSink()) {
    let loaded: AuditLoad;
    let blocked: string | null = null;
    try {
      loaded = sink.load();
    } catch (error) {
      blocked = `Could not read the existing audit log: ${error instanceof Error ? error.message : String(error)}`;
      loaded = { entries: [], problems: [blocked] };
    }
    this.blocked = blocked;
    this.entries = loaded.entries;
    this.persisted = loaded.entries.length;
    this.lastHash = loaded.entries.at(-1)?.hash ?? GENESIS_HASH;

    const chain = verifyChain(loaded.entries);
    this.integrity =
      chain.ok && loaded.problems.length
        ? { ok: false, entries: loaded.entries.length, brokenAt: loaded.entries.length + 1, reason: loaded.problems.join("; ") }
        : chain;
    if (blocked) this.lastError = blocked;
  }

  get size(): number {
    return this.entries.length;
  }

  record(input: NewAuditEntry): AuditEntry {
    const contents = {
      id: this.entries.length + 1,
      at: input.at,
      taskId: input.taskId,
      type: input.type,
      actor: input.actor,
      data: structuredClone(input.data), // later changes to the caller's object must not alter a hashed entry
      prevHash: this.lastHash
    };
    const entry: AuditEntry = { ...contents, hash: hashEntry(contents) };
    this.entries.push(entry);
    this.lastHash = entry.hash;
    this.flush();
    return structuredClone(entry);
  }

  /** Checks the whole log in memory. */
  verify(): ChainCheck {
    return verifyChain(this.entries);
  }

  query(query: AuditQuery = {}): AuditQueryResult {
    const order = query.order ?? "desc";
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_PAGE_LIMIT)));
    const since = query.since === undefined ? undefined : Date.parse(query.since);
    const until = query.until === undefined ? undefined : Date.parse(query.until);

    const matches = this.entries.filter(
      (entry) =>
        (query.taskId === undefined || entry.taskId === query.taskId) &&
        (query.type === undefined || entry.type === query.type) &&
        (query.actor === undefined || entry.actor === query.actor) &&
        (since === undefined || Date.parse(entry.at) >= since) &&
        (until === undefined || Date.parse(entry.at) <= until)
    );
    const ordered = order === "asc" ? matches : [...matches].reverse();

    const cursor = query.cursor ?? null;
    const start = cursor === null ? 0 : ordered.findIndex((entry) => (order === "asc" ? entry.id > cursor : entry.id < cursor));
    const from = start === -1 ? ordered.length : start;
    const page = ordered.slice(from, from + limit);
    const hasMore = from + limit < ordered.length;
    return { entries: structuredClone(page), nextCursor: hasMore ? page[page.length - 1].id : null, total: matches.length };
  }

  /** A copy of every entry, oldest first. */
  snapshot(): AuditEntry[] {
    return structuredClone(this.entries);
  }

  health(): AuditHealth {
    this.flush(); // a recovered disk catches up without waiting for the next decision
    const sink = this.sink.health();
    return {
      storage: this.sink.kind,
      location: this.sink.location ?? null,
      entries: this.entries.length,
      pending: this.entries.length - this.persisted,
      writable: sink.writable && this.lastError === null,
      lastError: this.lastError ?? sink.detail,
      integrity: this.integrity
    };
  }

  private flush(): void {
    if (this.blocked) return;
    while (this.persisted < this.entries.length) {
      try {
        this.sink.append(this.entries[this.persisted]);
        this.persisted++;
        this.lastError = null;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return;
      }
    }
  }
}
