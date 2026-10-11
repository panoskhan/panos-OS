/**
 * PANOS-OS Phase 7c — Swarm Wars tests
 * Runner: node --env-file=tests/test.env --experimental-eventsource --import tsx --test "tests/**\/*.test.ts"
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createKhanApiServer } from "../apps/api/src/index";
import { GhostRegistry } from "../packages/core/src/ghost";
import { STRATEGIES, SwarmArena, score, type Swarm } from "../packages/core/src/swarm";
import { classify } from "../services/rate-limit/src/index";
import { KhanOrchestrator } from "../services/orchestrator/src/orchestrator";

const OPEN_GOAL = "Summarize the repository layout.";
const GATED_GOAL = "Implement the fix and push the changes to GitHub.";

let tmpSeq = 0;
function tmpDir(): string {
  return path.join(os.tmpdir(), `swarm-test-${process.pid}-${tmpSeq++}`);
}

/** Waits for every contender's task to settle, then returns the arena's view. */
async function settle(orchestrator: KhanOrchestrator, swarm: Swarm): Promise<void> {
  for (const contender of swarm.contenders) await orchestrator.whenSettled(contender.taskId);
}

describe("the rubric", () => {
  it("gives 100 only to a contender that finished and passed QA", () => {
    assert.equal(score({ status: "completed", qaPassed: true, completedSteps: 3, totalSteps: 3 }), 100);
    assert.equal(score({ status: "completed", qaPassed: false, completedSteps: 3, totalSteps: 3 }), 40);
  });

  it("scores a failure or a cancellation 0, and a task parked at the gate 10", () => {
    assert.equal(score({ status: "failed", qaPassed: false, completedSteps: 2, totalSteps: 4 }), 0);
    assert.equal(score({ status: "cancelled", qaPassed: false, completedSteps: 2, totalSteps: 4 }), 0);
    assert.equal(score({ status: "waiting_approval", qaPassed: false, completedSteps: 2, totalSteps: 4 }), 10);
  });

  it("scores a task still moving by its progress, never above 50", () => {
    assert.equal(score({ status: "executing", qaPassed: false, completedSteps: 0, totalSteps: 4 }), 0);
    assert.equal(score({ status: "executing", qaPassed: false, completedSteps: 2, totalSteps: 4 }), 25);
    assert.equal(score({ status: "executing", qaPassed: false, completedSteps: 4, totalSteps: 4 }), 50);
    assert.equal(score({ status: "planning", qaPassed: false, completedSteps: 0, totalSteps: 0 }), 0);
  });
});

describe("SwarmArena", () => {
  it("fields four contenders on one problem and judges a winner once they finish", async () => {
    const orchestrator = new KhanOrchestrator();
    const arena = new SwarmArena(orchestrator);

    const { swarm } = arena.launch(OPEN_GOAL, "tester");
    assert.equal(swarm.contenders.length, 4);
    assert.deepEqual(
      swarm.contenders.map((c) => c.strategy),
      STRATEGIES.slice(0, 4)
    );
    assert.equal(new Set(swarm.contenders.map((c) => c.taskId)).size, 4, "each contender is its own task");

    await settle(orchestrator, swarm);
    const judged = arena.get(swarm.id).swarm;
    assert.equal(judged.status, "judged");
    assert.ok(judged.winner && STRATEGIES.includes(judged.winner));
    assert.ok(judged.verdict?.startsWith(judged.winner));
    for (const contender of judged.contenders) {
      assert.equal(contender.status, "completed");
      assert.equal(contender.qaPassed, true);
      assert.equal(contender.score, 100);
      assert.equal(contender.completedSteps, contender.totalSteps);
    }
  });

  it("runs every contender in its own audit lane, as the actor who launched the swarm", async () => {
    const orchestrator = new KhanOrchestrator();
    const arena = new SwarmArena(orchestrator);
    const { swarm } = arena.launch(OPEN_GOAL, "tester", 2);
    await settle(orchestrator, swarm);

    for (const contender of swarm.contenders) {
      const report = orchestrator.get(contender.taskId);
      assert.equal(report.task.projectId, `swarm:${contender.strategy}`);
      assert.equal(report.task.goal, OPEN_GOAL, "every contender gets the same problem");
      assert.equal(orchestrator.events(contender.taskId)[0].actor, "tester");
    }
  });

  it("declares no winner when the problem needs approval, and approves nothing itself", async () => {
    const orchestrator = new KhanOrchestrator();
    const arena = new SwarmArena(orchestrator);
    const { swarm } = arena.launch(GATED_GOAL, "tester");
    await settle(orchestrator, swarm);

    const result = arena.get(swarm.id).swarm;
    assert.equal(result.status, "no_winner");
    assert.equal(result.winner, undefined);
    assert.match(result.verdict ?? "", /4 of 4 contenders stopped at the approval gate/);
    for (const contender of result.contenders) {
      assert.equal(contender.status, "waiting_approval");
      assert.equal(contender.score, 10);
      // The task itself is the proof: the arena never called approve().
      assert.equal(orchestrator.get(contender.taskId).task.status, "waiting_approval");
    }
  });

  it("does not call a swarm judged while a contender is still moving", async () => {
    const orchestrator = new KhanOrchestrator();
    const arena = new SwarmArena(orchestrator);
    const { swarm } = arena.launch(OPEN_GOAL, "tester");
    // Read before anything has had a turn to settle.
    assert.equal(swarm.status, "running");
    assert.equal(swarm.winner, undefined);
    assert.equal(swarm.verdict, undefined);
    await settle(orchestrator, swarm);
  });

  it("refuses an empty problem and a size outside the limits", () => {
    const arena = new SwarmArena(new KhanOrchestrator());
    assert.throws(() => arena.launch("   ", "tester"), /problem_required/);
    for (const bad of [0, 1, 9, 2.5, Number.NaN]) {
      assert.throws(() => arena.launch(OPEN_GOAL, "tester", bad), /invalid_size/, `size ${bad}`);
    }
  });

  it("accepts the smallest and largest swarm", async () => {
    const orchestrator = new KhanOrchestrator();
    const arena = new SwarmArena(orchestrator);
    const small = arena.launch(OPEN_GOAL, "tester", 2).swarm;
    const large = arena.launch(OPEN_GOAL, "tester", 8).swarm;
    assert.equal(small.contenders.length, 2);
    assert.equal(large.contenders.length, 8);
    await settle(orchestrator, small);
    await settle(orchestrator, large);
  });

  it("throws swarm_not_found for an id it never issued", () => {
    assert.throws(() => new SwarmArena(new KhanOrchestrator()).get("swarm_nope"), /swarm_not_found/);
  });
});

describe("rate limiting", () => {
  it("charges a swarm to the task bucket, because it starts tasks", () => {
    assert.equal(classify("POST", "/v1/swarm"), "tasks");
    assert.equal(classify("POST", "/v1/tasks"), "tasks");
    assert.equal(classify("GET", "/v1/swarm"), "read");
  });
});

describe("swarm HTTP routes", () => {
  async function serve() {
    const orchestrator = new KhanOrchestrator();
    const ghosts = new GhostRegistry(orchestrator, tmpDir());
    const swarms = new SwarmArena(orchestrator);
    const server = createKhanApiServer(orchestrator, { ghosts, swarms });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    return {
      orchestrator,
      base,
      async close() {
        ghosts.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    };
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("starts a swarm with 202, then reports it judged", async () => {
    const { base, orchestrator, close } = await serve();
    try {
      const started = await post(`${base}/v1/swarm`, { problem: OPEN_GOAL, size: 3 });
      assert.equal(started.status, 202);
      const { swarm } = (await started.json()) as { swarm: Swarm };
      assert.equal(swarm.contenders.length, 3);

      for (const contender of swarm.contenders) await orchestrator.whenSettled(contender.taskId);
      const fetched = await fetch(`${base}/v1/swarm/${encodeURIComponent(swarm.id)}`);
      assert.equal(fetched.status, 200);
      const body = (await fetched.json()) as { swarm: Swarm };
      assert.equal(body.swarm.status, "judged");

      const listed = (await (await fetch(`${base}/v1/swarm`)).json()) as { swarms: Swarm[] };
      assert.equal(listed.swarms.length, 1);
      assert.equal(listed.swarms[0].id, swarm.id);
    } finally {
      await close();
    }
  });

  it("reports no_winner over HTTP for a gated problem", async () => {
    const { base, orchestrator, close } = await serve();
    try {
      const started = (await (await post(`${base}/v1/swarm`, { problem: GATED_GOAL })).json()) as { swarm: Swarm };
      for (const contender of started.swarm.contenders) await orchestrator.whenSettled(contender.taskId);
      const body = (await (await fetch(`${base}/v1/swarm/${started.swarm.id}`)).json()) as { swarm: Swarm };
      assert.equal(body.swarm.status, "no_winner");
    } finally {
      await close();
    }
  });

  it("answers bad input with the right 4xx", async () => {
    const { base, close } = await serve();
    try {
      const noProblem = await post(`${base}/v1/swarm`, {});
      assert.equal(noProblem.status, 400);
      assert.equal(((await noProblem.json()) as { error: string }).error, "problem_required");

      const badSize = await post(`${base}/v1/swarm`, { problem: OPEN_GOAL, size: 99 });
      assert.equal(badSize.status, 400);
      assert.equal(((await badSize.json()) as { error: string }).error, "invalid_size");

      const missing = await fetch(`${base}/v1/swarm/swarm_nope`);
      assert.equal(missing.status, 404);
      assert.equal(((await missing.json()) as { error: string }).error, "swarm_not_found");

      const badId = await fetch(`${base}/v1/swarm/%E0%A4%A`);
      assert.equal(badId.status, 400);

      const wrongMethod = await fetch(`${base}/v1/swarm/swarm_x`, { method: "DELETE" });
      assert.equal(wrongMethod.status, 405);
    } finally {
      await close();
    }
  });
});
