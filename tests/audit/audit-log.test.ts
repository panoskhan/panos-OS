import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry } from "../../packages/contracts/src/api";
import {
  AuditLog,
  FileAuditSink,
  GENESIS_HASH,
  MAX_PAGE_LIMIT,
  hashEntry,
  verifyChain,
  type AuditLoad,
  type AuditSink,
  type NewAuditEntry
} from "../../services/audit/src/index";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const input = (n: number, overrides: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
  at: at(n),
  taskId: "task_a",
  type: "task.created",
  actor: "system",
  data: { n },
  ...overrides
});

function withTempDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "khan-audit-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A sink whose writes can be made to fail, to prove a failing disk never breaks the log. */
class FlakySink implements AuditSink {
  readonly kind = "file" as const;
  readonly location = "flaky";
  failing = false;
  readonly written: AuditEntry[] = [];
  load(): AuditLoad {
    return { entries: [], problems: [] };
  }
  append(entry: AuditEntry): void {
    if (this.failing) throw new Error("disk full");
    this.written.push(entry);
  }
  health() {
    return { writable: !this.failing, detail: this.failing ? "disk full" : null };
  }
}

test("entries are numbered from 1 and each links to the one before it", () => {
  const log = new AuditLog();
  const [first, second, third] = [log.record(input(1)), log.record(input(2)), log.record(input(3))];

  assert.deepEqual([first.id, second.id, third.id], [1, 2, 3]);
  assert.equal(first.prevHash, GENESIS_HASH);
  assert.equal(second.prevHash, first.hash);
  assert.equal(third.prevHash, second.hash);
  for (const entry of [first, second, third]) assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(log.verify(), { ok: true, entries: 3 });
});

test("the same content hashes the same way regardless of key order, and any change alters the hash", () => {
  const a = new AuditLog();
  const b = new AuditLog();
  const one = a.record(input(1, { data: { x: 1, nested: { p: 2, q: [1, { z: 3, y: 4 }] } } }));
  const two = b.record(input(1, { data: { nested: { q: [1, { y: 4, z: 3 }], p: 2 }, x: 1 } }));
  assert.equal(one.hash, two.hash);

  const { hash: _hash, ...contents } = one;
  assert.equal(hashEntry(contents), one.hash);
  assert.notEqual(hashEntry({ ...contents, actor: "user:mallory" }), one.hash);
  assert.notEqual(hashEntry({ ...contents, data: { ...contents.data, x: 2 } }), one.hash);
  assert.notEqual(hashEntry({ ...contents, at: at(9) }), one.hash);
  assert.notEqual(hashEntry({ ...contents, taskId: null }), one.hash);
});

test("later changes to the caller's object cannot alter a recorded entry", () => {
  const log = new AuditLog();
  const data = { permissions: ["workspace.read"] };
  log.record(input(1, { data }));

  data.permissions.push("github.write");

  assert.deepEqual(log.query({}).entries[0].data, { permissions: ["workspace.read"] });
  assert.equal(log.verify().ok, true);
});

test("the chain check catches an altered entry, a removed one, reordering and a forged link", () => {
  const log = new AuditLog();
  for (let n = 1; n <= 5; n++) log.record(input(n));
  const original = log.snapshot();
  assert.equal(verifyChain(original).ok, true);

  const altered = structuredClone(original);
  altered[1].data = { n: 999 };
  assert.deepEqual(verifyChain(altered), { ok: false, entries: 5, brokenAt: 2, reason: "its contents do not match its recorded hash (it was altered)" });

  const removed = structuredClone(original);
  removed.splice(2, 1);
  const removedCheck = verifyChain(removed);
  assert.equal(removedCheck.ok, false);
  assert.equal(!removedCheck.ok && removedCheck.brokenAt, 3);
  assert.match(!removedCheck.ok ? removedCheck.reason : "", /removed, added or reordered/);

  const reordered = structuredClone(original);
  [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
  assert.equal(verifyChain(reordered).ok, false);

  const forgedLink = structuredClone(original);
  forgedLink[3].prevHash = GENESIS_HASH;
  const linkCheck = verifyChain(forgedLink);
  assert.equal(!linkCheck.ok && linkCheck.brokenAt, 4);
  assert.match(!linkCheck.ok ? linkCheck.reason : "", /does not link/);

  // An attacker who alters an entry and fixes its own hash is still caught: the next entry no longer links to it.
  const refixed = structuredClone(original);
  refixed[1].data = { n: 999 };
  const { hash: _hash, ...contents } = refixed[1];
  refixed[1].hash = hashEntry(contents);
  const refixedCheck = verifyChain(refixed);
  assert.equal(!refixedCheck.ok && refixedCheck.brokenAt, 3);
});

test("cutting entries off the end is NOT detected by the chain alone (it needs the latest hash kept elsewhere)", () => {
  const log = new AuditLog();
  for (let n = 1; n <= 4; n++) log.record(input(n));
  const truncated = log.snapshot().slice(0, 3);

  assert.deepEqual(verifyChain(truncated), { ok: true, entries: 3 });
});

test("a file-backed log survives a restart and continues the same chain", () => {
  withTempDir((dir) => {
    const file = join(dir, "nested", "audit.jsonl");
    const first = new AuditLog(new FileAuditSink(file));
    first.record(input(1));
    first.record(input(2));
    first.record(input(3));

    const second = new AuditLog(new FileAuditSink(file));
    assert.equal(second.size, 3);
    assert.deepEqual(second.health().integrity, { ok: true, entries: 3 });
    const fourth = second.record(input(4));
    assert.equal(fourth.id, 4);
    assert.equal(fourth.prevHash, second.snapshot()[2].hash);

    const third = new AuditLog(new FileAuditSink(file));
    assert.equal(third.size, 4);
    assert.deepEqual(third.verify(), { ok: true, entries: 4 });
    assert.deepEqual(third.snapshot(), second.snapshot());

    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 4);
    assert.deepEqual(lines.map((line) => (JSON.parse(line) as AuditEntry).id), [1, 2, 3, 4]);
  });
});

test("editing or deleting a line in the file is detected the next time the log starts", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(new FileAuditSink(file));
    for (let n = 1; n <= 4; n++) log.record(input(n));
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");

    writeFileSync(file, [lines[0], lines[1].replace('"n":2', '"n":99'), lines[2], lines[3]].join("\n") + "\n");
    const edited = new AuditLog(new FileAuditSink(file)).health();
    assert.equal(edited.entries, 4, "the entries are still loaded and readable");
    assert.equal(edited.integrity.ok, false);
    assert.equal(!edited.integrity.ok && edited.integrity.brokenAt, 2);

    writeFileSync(file, [lines[0], lines[2], lines[3]].join("\n") + "\n");
    const deleted = new AuditLog(new FileAuditSink(file)).health();
    assert.equal(deleted.integrity.ok, false);
    assert.equal(!deleted.integrity.ok && deleted.integrity.brokenAt, 2);
  });
});

test("a line cut short by a crash is reported, and the next entry starts on its own line", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    const log = new AuditLog(new FileAuditSink(file));
    log.record(input(1));
    log.record(input(2));
    appendFileSync(file, '{"id":3,"at":"2026-01'); // a write that never finished, with no newline

    const restarted = new AuditLog(new FileAuditSink(file));
    const health = restarted.health();
    assert.equal(restarted.size, 2);
    assert.equal(health.integrity.ok, false);
    assert.match(!health.integrity.ok ? health.integrity.reason : "", /line 3 is not valid JSON/);

    const next = restarted.record(input(3));
    assert.equal(next.id, 3);
    const lines = readFileSync(file, "utf8").split("\n");
    assert.equal(lines[2], '{"id":3,"at":"2026-01', "the broken line is left as evidence, not repaired");
    assert.equal((JSON.parse(lines[3]) as AuditEntry).id, 3, "the new entry is on its own line");
  });
});

test("a log that cannot be read is never written to, so it cannot be corrupted", () => {
  const appended: AuditEntry[] = [];
  const unreadable: AuditSink = {
    kind: "file",
    location: "unreadable",
    load() {
      throw new Error("EACCES: permission denied");
    },
    append(entry) {
      appended.push(entry);
    },
    health: () => ({ writable: true, detail: null })
  };

  const log = new AuditLog(unreadable);
  const entry = log.record(input(1));

  assert.equal(entry.id, 1);
  assert.equal(appended.length, 0, "nothing was written over the existing log");
  const health = log.health();
  assert.equal(health.writable, false);
  assert.match(health.lastError ?? "", /Could not read the existing audit log: EACCES/);
  assert.equal(health.integrity.ok, false);
});

test("a failing disk never breaks recording: entries stay readable, are held, and are written in order once it recovers", () => {
  const sink = new FlakySink();
  const log = new AuditLog(sink);
  log.record(input(1));
  log.record(input(2));

  sink.failing = true;
  const held = [log.record(input(3)), log.record(input(4))]; // must not throw
  assert.deepEqual(held.map((entry) => entry.id), [3, 4]);
  const failing = log.health();
  assert.equal(failing.writable, false);
  assert.equal(failing.pending, 2);
  assert.equal(failing.lastError, "disk full");
  assert.equal(log.query({ order: "asc" }).entries.length, 4, "held entries are still served");
  assert.deepEqual(sink.written.map((entry) => entry.id), [1, 2]);

  sink.failing = false;
  log.record(input(5));
  assert.deepEqual(sink.written.map((entry) => entry.id), [1, 2, 3, 4, 5], "held entries were written first, in order");
  assert.equal(log.health().pending, 0);
  assert.equal(log.health().writable, true);
  assert.equal(verifyChain(sink.written).ok, true, "what reached the disk is a gap-free, intact chain");
});

test("a recovered disk catches up on its own when the log is health-checked", () => {
  const sink = new FlakySink();
  const log = new AuditLog(sink);
  sink.failing = true;
  log.record(input(1));
  assert.equal(log.health().pending, 1);

  sink.failing = false;
  const health = log.health();

  assert.equal(health.pending, 0);
  assert.equal(health.writable, true);
  assert.deepEqual(sink.written.map((entry) => entry.id), [1]);
});

test("queries filter by task, type, actor and time, and count every match", () => {
  const log = new AuditLog();
  log.record(input(1, { taskId: "task_a", type: "task.created", actor: "user:alice" }));
  log.record(input(2, { taskId: "task_a", type: "step.started", actor: "system" }));
  log.record(input(3, { taskId: "task_b", type: "task.created", actor: "anonymous" }));
  log.record(input(4, { taskId: "task_b", type: "task.approved", actor: "user:alice" }));
  log.record(input(5, { taskId: null, type: "request.refused", actor: "anonymous" }));

  const ids = (query: Parameters<AuditLog["query"]>[0]) => log.query({ order: "asc", ...query }).entries.map((entry) => entry.id);
  assert.deepEqual(ids({ taskId: "task_b" }), [3, 4]);
  assert.deepEqual(ids({ type: "task.created" }), [1, 3]);
  assert.deepEqual(ids({ actor: "user:alice" }), [1, 4]);
  assert.deepEqual(ids({ actor: "user:alice", taskId: "task_b" }), [4]);
  assert.deepEqual(ids({ since: at(2), until: at(4) }), [2, 3, 4], "time bounds are inclusive");
  assert.deepEqual(ids({ since: at(99) }), []);
  assert.deepEqual(ids({ type: "no.such.type" }), []);
  assert.equal(log.query({ actor: "anonymous", limit: 1 }).total, 2, "total counts matches across all pages");
});

test("cursor paging visits every match once in either direction, and stays stable while entries are appended", () => {
  const log = new AuditLog();
  for (let n = 1; n <= 11; n++) log.record(input(n, { taskId: n % 2 ? "task_odd" : "task_even" }));

  // Ascending, with a new entry appended after the second page: nothing repeats or is skipped, and the new one is reached.
  const ascending: number[] = [];
  let cursor: number | null = null;
  let pages = 0;
  do {
    const page = log.query({ order: "asc", limit: 3, cursor });
    ascending.push(...page.entries.map((entry) => entry.id));
    cursor = page.nextCursor;
    if (++pages === 2) log.record(input(50));
  } while (cursor !== null);
  assert.deepEqual(ascending, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // Descending over what is now 12 entries: newest first, with the same total on every page.
  const descending: number[] = [];
  cursor = null;
  do {
    const page = log.query({ order: "desc", limit: 5, cursor });
    descending.push(...page.entries.map((entry) => entry.id));
    assert.equal(page.total, 12);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(descending, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

  const filtered = log.query({ taskId: "task_odd", order: "asc", limit: 2 });
  assert.deepEqual(filtered.entries.map((entry) => entry.id), [1, 3]);
  assert.equal(filtered.nextCursor, 3, "the cursor is the id of the last entry returned");
  assert.deepEqual(log.query({ taskId: "task_odd", order: "asc", limit: 2, cursor: filtered.nextCursor }).entries.map((entry) => entry.id), [5, 7]);
  assert.equal(log.query({ order: "asc", limit: 500, cursor: 12 }).entries.length, 0, "a cursor at the end returns nothing");
});

test("newest entries come first by default, and limits are clamped", () => {
  const log = new AuditLog();
  for (let n = 1; n <= 4; n++) log.record(input(n));

  assert.deepEqual(log.query().entries.map((entry) => entry.id), [4, 3, 2, 1]);
  assert.equal(log.query({ limit: 0 }).entries.length, 1);
  assert.equal(log.query({ limit: MAX_PAGE_LIMIT * 10 }).entries.length, 4);
});
