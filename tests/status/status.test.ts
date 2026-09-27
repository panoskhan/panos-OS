import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_AGENTS, createPlan } from "../../agents/planner/src/index";
import { verifyIndependentQa } from "../../agents/qa/src/index";
import type { PermissionDecision } from "../../services/permissions/src/index";
import { KhanOrchestrator, type OrchestratorDiagnostics } from "../../services/orchestrator/src/orchestrator";
import { collectStatus, type StatusDependencies } from "../../services/status/src/index";
import type { ComponentId, ComponentState, StatusResponse } from "../../packages/contracts/src/api";
import { gatedHandler } from "../support/orchestration";

const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

function depsFor(orchestrator: KhanOrchestrator, overrides: Partial<StatusDependencies> = {}): StatusDependencies {
  return {
    service: "test-service",
    version: "1.2.3",
    startedAt: 0,
    now: () => 5000,
    diagnostics: () => orchestrator.diagnostics(),
    planAgents: PLAN_AGENTS,
    verify: verifyIndependentQa,
    ...overrides
  };
}

const states = (status: StatusResponse) =>
  Object.fromEntries(status.components.map((component) => [component.id, component.state])) as Record<ComponentId, ComponentState>;
const component = (status: StatusResponse, id: ComponentId) => status.components.find((entry) => entry.id === id)!;

/** A permission engine that answers every question the same way. */
const engineThatAlways = (decision: PermissionDecision) => ({ decide: () => decision });
const withDiagnostics = (orchestrator: KhanOrchestrator, patch: Partial<OrchestratorDiagnostics>) => () => ({
  ...orchestrator.diagnostics(),
  ...patch
});

test("a healthy system reports four components up and the model router as not configured", () => {
  const status = collectStatus(depsFor(new KhanOrchestrator()));

  assert.equal(status.status, "ok");
  assert.deepEqual(status.components.map((entry) => entry.id), ["orchestrator", "model-router", "agents", "permissions", "qa"]);
  assert.deepEqual(states(status), {
    orchestrator: "up",
    "model-router": "not_configured",
    agents: "up",
    permissions: "up",
    qa: "up"
  });
  assert.equal(status.service, "test-service");
  assert.equal(status.version, "1.2.3");
  assert.equal(status.uptimeSeconds, 5);
  assert.equal(status.checkedAt, new Date(5000).toISOString());
  assert.match(component(status, "model-router").detail, /isn't used by the orchestrator/);
});

test("the orchestrator probe reports live task counts", async () => {
  const gate = gatedHandler();
  const orchestrator = new KhanOrchestrator(undefined, undefined, gate.handler);
  assert.deepEqual(component(collectStatus(depsFor(orchestrator)), "orchestrator").metrics, { tasks: 0, running: 0, waitingApproval: 0 });

  const running = orchestrator.start("Analyze this project and identify the next engineering tasks.");
  assert.deepEqual(component(collectStatus(depsFor(orchestrator)), "orchestrator").metrics, { tasks: 1, running: 1, waitingApproval: 0 });

  gate.releaseNext();
  await new Promise<void>((resolve) => {
    const unsubscribe = orchestrator.subscribe(running.task.id, (event) => {
      if (event.type === "step.started" && event.data.stepId === "analyze") {
        unsubscribe();
        resolve();
      }
    });
  });
  gate.releaseNext();
  await orchestrator.whenSettled(running.task.id);

  // A second task pauses at its approval gate once its (still gated) first step is released.
  const second = orchestrator.start(GITHUB_GOAL);
  gate.releaseNext();
  const paused = await orchestrator.whenSettled(second.task.id);
  assert.equal(paused.task.status, "waiting_approval");
  const detail = component(collectStatus(depsFor(orchestrator)), "orchestrator");
  assert.deepEqual(detail.metrics, { tasks: 2, running: 0, waitingApproval: 1 });
  assert.match(detail.detail, /2 tasks \(0 running, 1 awaiting approval\)/);
});

test("checking the status changes nothing", async () => {
  const orchestrator = new KhanOrchestrator();
  const { task } = await orchestrator.run("Analyze this project and identify the next engineering tasks.");
  const eventsBefore = orchestrator.events(task.id).length;
  const countsBefore = orchestrator.diagnostics().tasks;

  collectStatus(depsFor(orchestrator));
  collectStatus(depsFor(orchestrator));

  assert.equal(orchestrator.events(task.id).length, eventsBefore);
  assert.deepEqual(orchestrator.diagnostics().tasks, countsBefore);
});

test("agents are down when a plan agent has no handler", () => {
  const orchestrator = new KhanOrchestrator();
  const status = collectStatus(depsFor(orchestrator, { diagnostics: withDiagnostics(orchestrator, { registeredAgents: ["coding"] }) }));

  assert.equal(status.status, "degraded");
  assert.equal(component(status, "agents").state, "down");
  assert.match(component(status, "agents").detail, /No handler registered for: qa/);
  assert.deepEqual(
    [component(status, "orchestrator").state, component(status, "permissions").state, component(status, "qa").state],
    ["up", "up", "up"],
    "one failing component does not take the others down"
  );
});

test("permissions are down when the engine allows everything or denies everything", () => {
  const orchestrator = new KhanOrchestrator();
  const allowAll = collectStatus(
    depsFor(orchestrator, {
      diagnostics: withDiagnostics(orchestrator, { permissions: engineThatAlways({ allowed: true, requiresApproval: false, deniedPermissions: [] }) })
    })
  );
  assert.equal(component(allowAll, "permissions").state, "down");
  assert.match(component(allowAll, "permissions").detail, /github\.write is not approval-gated/);
  assert.match(component(allowAll, "permissions").detail, /unknown permissions are not denied/);

  const denyAll = collectStatus(
    depsFor(orchestrator, {
      diagnostics: withDiagnostics(orchestrator, {
        permissions: { decide: (required: string[]) => ({ allowed: false, requiresApproval: false, deniedPermissions: required }) }
      })
    })
  );
  assert.equal(component(denyAll, "permissions").state, "down");
  assert.match(component(denyAll, "permissions").detail, /workspace\.read is not allowed/);
  assert.equal(denyAll.status, "degraded");
});

test("independent QA is down when it accepts bad results, rejects good ones, or crashes", () => {
  const orchestrator = new KhanOrchestrator();
  const alwaysPasses = { passed: true, checks: [], findings: [] };
  const alwaysFails = { passed: false, checks: [], findings: [] };

  const rubberStamp = collectStatus(depsFor(orchestrator, { verify: () => alwaysPasses }));
  assert.equal(component(rubberStamp, "qa").state, "down");
  assert.match(component(rubberStamp, "qa").detail, /accepted a failed result and accepted a result that ignores the goal/);

  const paranoid = collectStatus(depsFor(orchestrator, { verify: () => alwaysFails }));
  assert.equal(component(paranoid, "qa").state, "down");
  assert.match(component(paranoid, "qa").detail, /rejected a valid result/);

  const crashing = collectStatus(
    depsFor(orchestrator, {
      verify: () => {
        throw new Error("boom");
      }
    })
  );
  assert.equal(component(crashing, "qa").state, "down");
  assert.equal(component(crashing, "qa").detail, "Self-test crashed: boom");
});

test("a crashing diagnostics call takes down only what depends on it, and never throws", () => {
  const orchestrator = new KhanOrchestrator();
  const status = collectStatus(
    depsFor(orchestrator, {
      diagnostics: () => {
        throw new Error("store unavailable");
      }
    })
  );

  assert.equal(status.status, "degraded");
  assert.deepEqual(states(status), {
    orchestrator: "down",
    "model-router": "not_configured",
    agents: "down",
    permissions: "down",
    qa: "up"
  });
  assert.equal(component(status, "orchestrator").detail, "Self-test crashed: store unavailable");
});

test("uptime is formatted for humans and never negative", () => {
  const orchestrator = new KhanOrchestrator();
  const detailAt = (elapsedMs: number) =>
    component(collectStatus(depsFor(orchestrator, { startedAt: 0, now: () => elapsedMs })), "orchestrator").detail;

  assert.match(detailAt(7_000), /^Up 7s\./);
  assert.match(detailAt(65_000), /^Up 1m 5s\./);
  assert.match(detailAt(3_661_000), /^Up 1h 1m\./);
  assert.equal(collectStatus(depsFor(orchestrator, { startedAt: 10_000, now: () => 4_000 })).uptimeSeconds, 0);
});

test("every agent a plan can name has a handler in a fresh orchestrator", () => {
  const goals = [
    "Analyze this project and identify the next engineering tasks.",
    "Test the orchestration pipeline.",
    "Implement a safer approval flow.",
    GITHUB_GOAL
  ];
  const planned = new Set(goals.flatMap((goal) => createPlan(goal).map((step) => step.agent)));
  const registered = new KhanOrchestrator().diagnostics().registeredAgents;

  for (const agent of planned) assert.ok((PLAN_AGENTS as readonly string[]).includes(agent), `planner used unlisted agent '${agent}'`);
  for (const agent of PLAN_AGENTS) assert.ok(registered.includes(agent), `no handler registered for plan agent '${agent}'`);
});
