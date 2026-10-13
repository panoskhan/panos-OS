/**
 * PANOS-OS Phase 7a — Ghost Mode tests
 * Runner: node --env-file=tests/test.env --experimental-eventsource --import tsx --test "tests/**\/*.test.ts"
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GhostRegistry, MIN_INTERVAL_MS, type Ghost } from "../packages/core/src/ghost";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Records every orchestrator.start() a ghost makes. */
function stubOrchestrator() {
  const calls: { goal: string; projectId?: string; actor?: string }[] = [];
  return {
    calls,
    start(goal: string, projectId?: string, actor?: string) {
      calls.push({ goal, projectId, actor });
      return { task: { id: `stub-${calls.length}` } };
    }
  };
}

let tmpSeq = 0;
/** A throwaway data dir, so no two registries share a ghosts.jsonl. */
function tmpDir(): string {
  return path.join(os.tmpdir(), `ghost-test-${process.pid}-${tmpSeq++}`);
}

/** A registry whose minimum interval is 20 ms, so timer tests finish fast. */
function fastRegistry(orchestrator: ReturnType<typeof stubOrchestrator>) {
  return new GhostRegistry(orchestrator, tmpDir(), 20);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ─── Unit tests: GhostRegistry ────────────────────────────────────────────────

describe("GhostRegistry", () => {
  it("register returns an active ghost with a fresh id", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    const { ghost } = reg.register("do something", { type: "interval", ms: 10_000 }, "tester");
    assert.equal(ghost.status, "active");
    assert.equal(ghost.goal, "do something");
    assert.equal(ghost.actor, "tester");
    assert.equal(ghost.fireCount, 0);
    assert.ok(ghost.id.length > 0);
    reg.close();
  });

  it("list omits removed ghosts", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    const { ghost: gone } = reg.register("goal 1", { type: "interval", ms: 10_000 }, "tester");
    const { ghost: kept } = reg.register("goal 2", { type: "interval", ms: 10_000 }, "tester");
    reg.remove(gone.id);
    assert.deepEqual(reg.list().map((g: Ghost) => g.id), [kept.id]);
    reg.close();
  });

  it("pause then resume round-trips the status", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    const { ghost } = reg.register("toggle me", { type: "interval", ms: 10_000 }, "tester");
    assert.equal(reg.pause(ghost.id).ghost.status, "paused");
    assert.equal(reg.resume(ghost.id).ghost.status, "active");
    reg.close();
  });

  it("fires on its interval, incrementing fireCount and stamping lastFiredAt", async () => {
    const orch = stubOrchestrator();
    const reg = fastRegistry(orch);
    const { ghost } = reg.register("fire me", { type: "interval", ms: 20 }, "tester");
    await sleep(120);
    reg.close();

    const current = reg.get(ghost.id).ghost;
    assert.ok(current.fireCount >= 1, `expected at least one firing, got ${current.fireCount}`);
    assert.ok(current.lastFiredAt, "lastFiredAt should be stamped after a firing");
    assert.ok(orch.calls.length >= 1);
    assert.equal(orch.calls[0].goal, "fire me");
    // Ghost-born tasks are tagged so the audit log can tell them from voice/API tasks.
    assert.equal(orch.calls[0].projectId, "ghost");
    assert.equal(orch.calls[0].actor, "tester");
  });

  it("does not fire while paused", async () => {
    const orch = stubOrchestrator();
    const reg = fastRegistry(orch);
    const { ghost } = reg.register("paused goal", { type: "interval", ms: 20 }, "tester");
    reg.pause(ghost.id);
    await sleep(120);
    reg.close();
    assert.equal(orch.calls.length, 0);
  });

  it("does not fire after remove", async () => {
    const orch = stubOrchestrator();
    const reg = fastRegistry(orch);
    const { ghost } = reg.register("removed goal", { type: "interval", ms: 20 }, "tester");
    reg.remove(ghost.id);
    await sleep(120);
    reg.close();
    assert.equal(orch.calls.length, 0);
  });

  it("keeps firing when the orchestrator throws", async () => {
    const reg = fastRegistry({
      calls: [],
      start() {
        throw new Error("orchestrator is busy");
      }
    } as unknown as ReturnType<typeof stubOrchestrator>);
    const { ghost } = reg.register("doomed goal", { type: "interval", ms: 20 }, "tester");
    await sleep(120);
    reg.close();
    // A rejected firing must not count, and must not kill the ghost.
    const current = reg.get(ghost.id).ghost;
    assert.equal(current.fireCount, 0);
    assert.equal(current.status, "active");
  });

  it("rejects an interval below the minimum", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    assert.throws(
      () => reg.register("goal", { type: "interval", ms: MIN_INTERVAL_MS - 1 }, "tester"),
      /interval_too_short/
    );
    reg.close();
  });

  it("throws ghost_not_found for an unknown id", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    assert.throws(() => reg.get("no-such-id"), /ghost_not_found/);
    reg.close();
  });

  it("throws ghost_deleted when pausing a removed ghost", () => {
    const reg = new GhostRegistry(stubOrchestrator(), tmpDir());
    const { ghost } = reg.register("delete me", { type: "interval", ms: 10_000 }, "tester");
    reg.remove(ghost.id);
    assert.throws(() => reg.pause(ghost.id), /ghost_deleted/);
    reg.close();
  });

  it("reloads ghosts written by an earlier registry", () => {
    const dir = tmpDir();
    const first = new GhostRegistry(stubOrchestrator(), dir);
    const { ghost } = first.register("survive restart", { type: "interval", ms: 10_000 }, "tester");
    first.close();

    const second = new GhostRegistry(stubOrchestrator(), dir);
    assert.equal(second.get(ghost.id).ghost.goal, "survive restart");
    second.close();
  });
});

// ─── Integration tests: /v1/ghost ─────────────────────────────────────────────

/** Minimal HTTP helper — avoids native fetch to keep Node 18 compatibility */
function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as { port: number };
    const raw = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(raw ? { "Content-Length": Buffer.byteLength(raw) } : {})
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw: data } });
          }
        });
      }
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

describe("/v1/ghost", () => {
  let server: http.Server;

  before(async () => {
    const { createKhanApiServer } = await import("../apps/api/src/index.js");
    server = createKhanApiServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  });

  after(() => {
    server.close();
  });

  /** Registers a ghost and returns its id. */
  async function newGhost(goal: string): Promise<string> {
    const { status, body } = await request(server, "POST", "/v1/ghost", {
      goal,
      schedule: { type: "interval", ms: 30_000 }
    });
    assert.equal(status, 201);
    return (body.ghost as Ghost).id;
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  it("POST creates a ghost and returns 201", async () => {
    const { status, body } = await request(server, "POST", "/v1/ghost", {
      goal: "monitor the system",
      schedule: { type: "interval", ms: 60_000 }
    });
    assert.equal(status, 201);
    const ghost = body.ghost as Ghost;
    assert.ok(ghost.id.length > 0);
    assert.equal(ghost.goal, "monitor the system");
    assert.equal(ghost.status, "active");
    assert.equal(ghost.fireCount, 0);
  });

  it("POST without a goal returns 400 goal_required", async () => {
    const { status, body } = await request(server, "POST", "/v1/ghost", {
      schedule: { type: "interval", ms: 60_000 }
    });
    assert.equal(status, 400);
    assert.equal(body.error, "goal_required");
  });

  it("POST without a schedule returns 400 schedule_required", async () => {
    const { status, body } = await request(server, "POST", "/v1/ghost", { goal: "some goal" });
    assert.equal(status, 400);
    assert.equal(body.error, "schedule_required");
  });

  it("POST with an unsupported schedule type returns 400 invalid_schedule", async () => {
    const { status, body } = await request(server, "POST", "/v1/ghost", {
      goal: "some goal",
      schedule: { type: "cron", expression: "* * * * *" }
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_schedule");
  });

  it("POST below the minimum interval returns 400 interval_too_short", async () => {
    const { status, body } = await request(server, "POST", "/v1/ghost", {
      goal: "some goal",
      schedule: { type: "interval", ms: 100 }
    });
    assert.equal(status, 400);
    assert.equal(body.error, "interval_too_short");
  });

  // ── GET collection ─────────────────────────────────────────────────────────
  it("GET returns the registered ghosts", async () => {
    const id = await newGhost("list test ghost");
    const { status, body } = await request(server, "GET", "/v1/ghost");
    assert.equal(status, 200);
    const ghosts = body.ghosts as Ghost[];
    assert.ok(Array.isArray(ghosts));
    assert.ok(ghosts.some((g) => g.id === id));
  });

  // ── GET one ────────────────────────────────────────────────────────────────
  it("GET /:id returns that ghost", async () => {
    const id = await newGhost("get by id test");
    const { status, body } = await request(server, "GET", `/v1/ghost/${id}`);
    assert.equal(status, 200);
    assert.equal((body.ghost as Ghost).id, id);
  });

  it("GET /:id returns 404 for an unknown id", async () => {
    const { status, body } = await request(server, "GET", "/v1/ghost/no-such-id");
    assert.equal(status, 404);
    assert.equal(body.error, "ghost_not_found");
  });

  // ── PATCH ──────────────────────────────────────────────────────────────────
  it("PATCH pauses and resumes", async () => {
    const id = await newGhost("toggle via HTTP");

    const paused = await request(server, "PATCH", `/v1/ghost/${id}`, { action: "pause" });
    assert.equal(paused.status, 200);
    assert.equal((paused.body.ghost as Ghost).status, "paused");

    const resumed = await request(server, "PATCH", `/v1/ghost/${id}`, { action: "resume" });
    assert.equal(resumed.status, 200);
    assert.equal((resumed.body.ghost as Ghost).status, "active");
  });

  it("PATCH with an unknown action returns 400 invalid_action", async () => {
    const id = await newGhost("bad action test");
    const { status, body } = await request(server, "PATCH", `/v1/ghost/${id}`, { action: "destroy" });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_action");
  });

  it("PATCH on an unknown id returns 404", async () => {
    const { status, body } = await request(server, "PATCH", "/v1/ghost/no-such-id", { action: "pause" });
    assert.equal(status, 404);
    assert.equal(body.error, "ghost_not_found");
  });

  // ── DELETE ─────────────────────────────────────────────────────────────────
  it("DELETE removes the ghost and drops it from the list", async () => {
    const id = await newGhost("delete me");

    const { status, body } = await request(server, "DELETE", `/v1/ghost/${id}`);
    assert.equal(status, 200);
    assert.equal((body.ghost as Ghost).status, "deleted");

    const list = await request(server, "GET", "/v1/ghost");
    assert.ok(!(list.body.ghosts as Ghost[]).some((g) => g.id === id));
  });

  it("DELETE on an unknown id returns 404", async () => {
    const { status, body } = await request(server, "DELETE", "/v1/ghost/no-such-id");
    assert.equal(status, 404);
    assert.equal(body.error, "ghost_not_found");
  });
});
