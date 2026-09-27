import assert from "node:assert/strict";
import test from "node:test";
import { PLAN_AGENTS, createPlan } from "../../agents/planner/src/index";
import { verifyIndependentQa } from "../../agents/qa/src/index";
import type { PermissionDecision } from "../../services/permissions/src/index";
import { KhanOrchestrator, type OrchestratorDiagnostics } from "../../services/orchestrator/src/orchestrator";
import { collectStatus, type RateLimiterProbe, type StatusDependencies } from "../../services/status/src/index";
import { DEFAULT_RATE_LIMITS, RateLimiter } from "../../services/rate-limit/src/index";
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
    rateLimiter: new RateLimiter(DEFAULT_RATE_LIMITS),
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

test("a healthy system reports four components up; the model router and an in-memory audit log are not configured", () => {
  const status = collectStatus(depsFor(new KhanOrchestrator()));

  assert.equal(status.status, "ok");
  assert.deepEqual(status.components.map((entry) => entry.id), ["orchestrator", "model-router", "agents", "permissions", "qa", "audit", "rate-limiter"]);
  assert.deepEqual(states(status), {
    orchestrator: "up",
    "model-router": "not_configured",
    agents: "up",
    permissions: "up",
    qa: "up",
    audit: "not_configured",
    "rate-limiter": "up"
  });
  assert.equal(status.service, "test-service");
  assert.equal(status.version, "1.2.3");
  assert.equal(status.uptimeSeconds, 5);
  assert.equal(status.checkedAt, new Date(5000).toISOString());
  assert.match(component(status, "model-router").detail, /No model is configured.*NVIDIA_API_KEY/);
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
    qa: "up",
    audit: "down",
    "rate-limiter": "up"
  });
  assert.equal(component(status, "orchestrator").detail, "Self-test crashed: store unavailable");
});

const okChain = { ok: true, entries: 42 } as const;
const withAudit = (orchestrator: KhanOrchestrator, audit: Partial<OrchestratorDiagnostics["audit"]>) =>
  withDiagnostics(orchestrator, { audit: { ...orchestrator.diagnostics().audit, ...audit } });

test("the audit component is up, with the entry count and writability, when a file log is recording", () => {
  const orchestrator = new KhanOrchestrator();
  const status = collectStatus(
    depsFor(orchestrator, {
      diagnostics: withAudit(orchestrator, { storage: "file", location: "data/audit.jsonl", entries: 42, pending: 0, writable: true, lastError: null, integrity: okChain })
    })
  );

  assert.equal(component(status, "audit").state, "up");
  assert.equal(component(status, "audit").detail, "Recording to data/audit.jsonl. 42 entries, file writable, hash chain intact.");
  assert.deepEqual(component(status, "audit").metrics, { entries: 42, writable: 1, pending: 0 });
  assert.equal(status.status, "ok");

  const one = collectStatus(depsFor(orchestrator, { diagnostics: withAudit(orchestrator, { storage: "file", location: "a.jsonl", entries: 1, integrity: { ok: true, entries: 1 } }) }));
  assert.match(component(one, "audit").detail, /\. 1 entry, file writable/);
});

test("the audit component is not configured while the log is in memory only", () => {
  const status = collectStatus(depsFor(new KhanOrchestrator()));

  assert.equal(component(status, "audit").state, "not_configured");
  assert.match(component(status, "audit").detail, /in memory only, so the log is lost on restart\. 0 entries\. Set KHAN_AUDIT_FILE to keep it\./);
  assert.equal(status.status, "ok", "not configured does not degrade the system");
});

test("the audit component is down when it cannot write, and says why and how much is waiting", () => {
  const orchestrator = new KhanOrchestrator();
  const status = collectStatus(
    depsFor(orchestrator, {
      diagnostics: withAudit(orchestrator, { storage: "file", location: "/var/khan/audit.jsonl", entries: 9, pending: 3, writable: false, lastError: "EACCES: permission denied", integrity: { ok: true, entries: 6 } })
    })
  );

  assert.equal(component(status, "audit").state, "down");
  assert.equal(component(status, "audit").detail, "Not writing to /var/khan/audit.jsonl: EACCES: permission denied. 9 entries held in memory, 3 not yet written.");
  assert.deepEqual(component(status, "audit").metrics, { entries: 9, writable: 0, pending: 3 });
  assert.equal(status.status, "degraded");
});

test("the audit component is down when the hash chain is broken, even if the disk is writable", () => {
  const orchestrator = new KhanOrchestrator();
  const status = collectStatus(
    depsFor(orchestrator, {
      diagnostics: withAudit(orchestrator, {
        storage: "file",
        location: "data/audit.jsonl",
        entries: 10,
        writable: true,
        integrity: { ok: false, entries: 10, brokenAt: 4, reason: "its contents do not match its recorded hash (it was altered)" }
      })
    })
  );

  assert.equal(component(status, "audit").state, "down");
  assert.equal(component(status, "audit").detail, "Hash chain broken at entry 4: its contents do not match its recorded hash (it was altered).");
  assert.equal(status.status, "degraded");
});

test("the rate limiter component reports its configuration and how much it has refused", () => {
  const orchestrator = new KhanOrchestrator();
  const limiter = new RateLimiter({ tasks: 2, read: 60, audit: 0 });
  limiter.check("tasks", "a");
  limiter.check("tasks", "a");
  limiter.check("tasks", "a"); // refused

  const status = collectStatus(depsFor(orchestrator, { rateLimiter: limiter }));

  assert.equal(component(status, "rate-limiter").state, "up");
  assert.equal(
    component(status, "rate-limiter").detail,
    "Per client: task creation 2/min, other requests 60/min, audit reads off. 1 client bucket tracked, 1 request refused so far."
  );
  assert.deepEqual(component(status, "rate-limiter").metrics, { tasksPerMinute: 2, readPerMinute: 60, auditPerMinute: 0, tracked: 1, limitedTotal: 1 });
  assert.equal(status.status, "ok");
});

test("the rate limiter is not configured when every limit is off, and down when its self-test fails", () => {
  const orchestrator = new KhanOrchestrator();
  const off = collectStatus(depsFor(orchestrator, { rateLimiter: new RateLimiter({ tasks: 0, read: 0, audit: 0 }) }));
  assert.equal(component(off, "rate-limiter").state, "not_configured");
  assert.equal(component(off, "rate-limiter").detail, "Rate limiting is off: every limit is 0.");
  assert.equal(off.status, "ok", "not configured does not degrade the system");

  const broken: RateLimiterProbe = {
    describe: () => ({ limits: DEFAULT_RATE_LIMITS, tracked: 0, limitedTotal: 0 }),
    selfTest: () => ["a request over the limit was not refused with the right wait"]
  };
  const down = collectStatus(depsFor(orchestrator, { rateLimiter: broken }));
  assert.equal(component(down, "rate-limiter").state, "down");
  assert.match(component(down, "rate-limiter").detail, /^Self-test failed: a request over the limit was not refused/);
  assert.equal(down.status, "degraded");

  const crashing: RateLimiterProbe = {
    describe: () => {
      throw new Error("bucket table corrupt");
    },
    selfTest: () => []
  };
  assert.equal(component(collectStatus(depsFor(orchestrator, { rateLimiter: crashing })), "rate-limiter").detail, "Self-test crashed: bucket table corrupt");
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
