import assert from "node:assert/strict";
import test from "node:test";
import type { AuditEntry, TaskEvent } from "../../packages/contracts/src/api";
import type { AgentResult } from "../../packages/contracts/src/agent";
import { PlanningError, type PlanStep } from "../../agents/planner/src/index";
import { AuditLog, type AuditLoad, type AuditSink } from "../../services/audit/src/index";
import type { AgentHandler } from "../../services/agents/src/runtime";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { gatedHandler, stepStarted, waitForEvent } from "../support/orchestration";

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

function setup(options: { handler?: AgentHandler; plan?: (goal: string) => PlanStep[]; audit?: AuditLog } = {}) {
  const audit = options.audit ?? new AuditLog();
  const orchestrator = new KhanOrchestrator(undefined, options.plan, options.handler, undefined, audit);
  const entriesFor = (taskId: string): AuditEntry[] => audit.query({ taskId, order: "asc", limit: 500 }).entries;
  const types = (taskId: string) => entriesFor(taskId).map((entry) => entry.type);
  const find = (taskId: string, type: string, predicate: (entry: AuditEntry) => boolean = () => true) =>
    entriesFor(taskId).find((entry) => entry.type === type && predicate(entry));
  return { audit, orchestrator, entriesFor, types, find };
}

const singleStep = (permissions: string[]): PlanStep[] => [
  { id: "risky", title: "Do something", agent: "coding", permissions, dependsOn: [] }
];

test("every task event becomes an audit entry with the same type, actor and data, in order", async () => {
  const { audit, orchestrator, entriesFor } = setup();
  const { task } = await orchestrator.run(ANALYSIS_GOAL);

  const events: TaskEvent[] = orchestrator.events(task.id);
  const entries = entriesFor(task.id);

  assert.deepEqual(entries.map((entry) => [entry.type, entry.actor, entry.data, entry.at, entry.taskId]), events.map((event) => [event.type, event.actor, event.data, event.at, event.taskId]));
  assert.ok(entries.every((entry, index) => index === 0 || entry.id > entries[index - 1].id), "ids only ever increase");
  assert.deepEqual(audit.verify(), { ok: true, entries: entries.length });
});

test("a full analysis run records each permission decision, the QA verdict and the completion", async () => {
  const { orchestrator, types, find } = setup();
  const { task } = await orchestrator.run(ANALYSIS_GOAL);

  assert.deepEqual(types(task.id), [
    "task.created",
    "task.status_changed", // understanding
    "task.status_changed", // planning
    "plan.created",
    "task.status_changed", // executing
    "permission.decided",
    "step.started",
    "step.completed",
    "permission.decided",
    "step.started",
    "step.completed",
    "permission.decided",
    "step.started",
    "step.completed",
    "qa.verdict",
    "task.status_changed", // verifying
    "task.status_changed", // completed
    "task.completed"
  ]);
  assert.deepEqual(find(task.id, "permission.decided")?.data, {
    stepId: "inspect",
    agent: "coding",
    permissions: ["workspace.read"],
    decision: "allowed",
    deniedPermissions: [],
    preApproved: []
  });
  assert.equal(find(task.id, "qa.verdict")?.data.passed, true);
  assert.deepEqual(find(task.id, "task.completed")?.data.checks, ["agent-results-present", "agent-results-successful", "findings-present", "goal-referenced"]);
  assert.match(String(find(task.id, "step.completed")?.data.summary), /Executed coding agent step 'inspect'/);
});

test("an approval gate records the request with its permissions, then who approved and why", async () => {
  const { orchestrator, entriesFor, find } = setup();
  const paused = await orchestrator.run(GITHUB_GOAL);
  const id = paused.task.id;
  const permissions = ["workspace.read", "workspace.write", "github.write"];

  assert.deepEqual(find(id, "permission.decided", (entry) => entry.data.stepId === "implement")?.data, {
    stepId: "implement",
    agent: "coding",
    permissions,
    decision: "needs_approval",
    deniedPermissions: [],
    preApproved: []
  });
  assert.deepEqual(find(id, "step.waiting_approval")?.data, { stepId: "implement", agent: "coding", permissions });
  const before = entriesFor(id).length;

  orchestrator.approve(id, "Reviewed the diff", "user:alice");
  await orchestrator.whenSettled(id);

  const after = entriesFor(id).slice(before);
  const approved = after[0];
  assert.deepEqual([approved.type, approved.actor, approved.data], ["task.approved", "user:alice", { stepId: "implement", permissions, reason: "Reviewed the diff" }]);
  assert.deepEqual([after[1].type, after[1].actor, after[1].data], ["task.status_changed", "user:alice", { from: "waiting_approval", to: "executing" }]);
  const rerun = after.find((entry) => entry.type === "permission.decided");
  assert.equal(rerun?.data.decision, "allowed");
  assert.deepEqual(rerun?.data.preApproved, permissions, "the audit trail shows the permissions were allowed because they were approved");
  assert.equal(rerun?.actor, "system");
  assert.equal(entriesFor(id).at(-1)?.type, "task.completed");
});

test("a rejection records who rejected, why, and that it ended the task", async () => {
  const { orchestrator, entriesFor, find } = setup();
  const { task } = await orchestrator.run(GITHUB_GOAL);
  const before = entriesFor(task.id).length;

  orchestrator.reject(task.id, "Too risky", "user:bob");

  const after = entriesFor(task.id).slice(before);
  assert.deepEqual(after.map((entry) => [entry.type, entry.actor]), [
    ["task.rejected", "user:bob"],
    ["task.status_changed", "user:bob"],
    ["task.failed", "user:bob"]
  ]);
  assert.equal(after[0].data.reason, "Too risky");
  assert.equal(find(task.id, "task.failed")?.data.stage, "approval_rejected");
  assert.equal(find(task.id, "task.failed")?.data.stepId, "implement");
});

test("cancelling records who, why, and which step was running", async () => {
  const gate = gatedHandler();
  const { orchestrator, entriesFor, find } = setup({ handler: gate.handler });
  const started = orchestrator.start(ANALYSIS_GOAL);
  await waitForEvent(orchestrator, started.task.id, stepStarted("inspect"));

  orchestrator.cancel(started.task.id, "Wrong project", "user:carol");
  gate.releaseNext();
  await orchestrator.whenSettled(started.task.id);

  const cancelled = find(started.task.id, "task.cancelled");
  assert.equal(cancelled?.actor, "user:carol");
  assert.deepEqual(cancelled?.data, { fromStatus: "executing", duringStep: "inspect", reason: "Wrong project" });
  assert.equal(entriesFor(started.task.id).find((entry) => entry.type === "step.completed")?.actor, "system", "the step that was already running still finished and was recorded");
});

test("who created a task is recorded, defaulting to anonymous", async () => {
  const { orchestrator, find } = setup();
  const anonymous = orchestrator.start(ANALYSIS_GOAL);
  const named = orchestrator.start(ANALYSIS_GOAL, "default", "user:dana");
  await Promise.all([orchestrator.whenSettled(anonymous.task.id), orchestrator.whenSettled(named.task.id)]);

  assert.equal(find(anonymous.task.id, "task.created")?.actor, "anonymous");
  assert.equal(find(named.task.id, "task.created")?.actor, "user:dana");
});

test("a planning failure records the stage and a code", async () => {
  const empty = setup({
    plan: () => {
      throw new PlanningError("empty_goal", "Goal is required");
    }
  });
  const { task } = await empty.orchestrator.run("anything");
  assert.deepEqual(empty.find(task.id, "task.failed")?.data, {
    stage: "planning",
    checks: ["planning"],
    findings: ["Goal is required"],
    code: "empty_goal"
  });

  const broken = setup({
    plan: () => {
      throw new Error("planner exploded");
    }
  });
  const other = await broken.orchestrator.run("anything");
  assert.equal(broken.find(other.task.id, "task.failed")?.data.code, "planner_error");
});

test("an invalid plan records the validation failure", async () => {
  const { orchestrator, find, types } = setup({
    plan: () => [{ id: "a", title: "A", agent: "coding", permissions: ["workspace.read"], dependsOn: ["missing"] }]
  });
  const { task } = await orchestrator.run("anything");

  assert.equal(find(task.id, "task.failed")?.data.stage, "plan_validation");
  assert.ok(types(task.id).includes("plan.created"), "the plan that failed validation is on record");
  assert.ok(!types(task.id).includes("step.started"));
});

test("a denied permission is recorded as denied, with the permissions, and the step never starts", async () => {
  const { orchestrator, find, types } = setup({ plan: () => singleStep(["unknown.permission"]) });
  const { task } = await orchestrator.run("anything");

  assert.equal(find(task.id, "permission.decided")?.data.decision, "denied");
  assert.deepEqual(find(task.id, "permission.decided")?.data.deniedPermissions, ["unknown.permission"]);
  assert.deepEqual(find(task.id, "step.failed")?.data, {
    stepId: "risky",
    agent: "coding",
    reason: "Permissions denied: unknown.permission",
    deniedPermissions: ["unknown.permission"]
  });
  assert.equal(find(task.id, "task.failed")?.data.stage, "agent_execution");
  assert.ok(!types(task.id).includes("step.started"), "a denied step never ran");
});

test("an agent that throws is recorded with the reason", async () => {
  const { orchestrator, find } = setup({
    handler: async () => {
      throw new Error("model unavailable");
    }
  });
  const { task } = await orchestrator.run(ANALYSIS_GOAL);

  assert.equal(find(task.id, "step.failed")?.data.reason, "Agent 'coding' threw: model unavailable");
  assert.equal(find(task.id, "task.failed")?.data.stage, "agent_execution");
  assert.deepEqual(find(task.id, "task.failed")?.data.findings, ["model unavailable"]);
});

test("a QA rejection records the verdict and fails the task at the qa stage", async () => {
  const unrelated: AgentResult = { status: "success", summary: "Completed successfully", findings: ["Nothing about the goal."] };
  const { orchestrator, find, types } = setup({ handler: () => unrelated });
  const { task } = await orchestrator.run(ANALYSIS_GOAL);

  const verdict = find(task.id, "qa.verdict");
  assert.equal(verdict?.data.passed, false);
  assert.ok((verdict?.data.findings as string[]).includes("Execution results do not reference the requested goal."));
  assert.equal(find(task.id, "task.failed")?.data.stage, "qa");
  assert.ok(types(task.id).indexOf("qa.verdict") < types(task.id).indexOf("task.failed"));
});

test("a failing audit sink never disturbs a task or its live events", async () => {
  class BrokenSink implements AuditSink {
    readonly kind = "file" as const;
    readonly location = "broken";
    load(): AuditLoad {
      return { entries: [], problems: [] };
    }
    append(): void {
      throw new Error("disk full");
    }
    health() {
      return { writable: false, detail: "disk full" };
    }
  }
  const audit = new AuditLog(new BrokenSink());
  const { orchestrator, entriesFor } = setup({ audit });
  const seen: string[] = [];
  const started = orchestrator.start(ANALYSIS_GOAL);
  orchestrator.subscribe(started.task.id, (event) => seen.push(event.type));

  const report = await orchestrator.whenSettled(started.task.id);

  assert.equal(report.task.status, "completed");
  assert.equal(report.verification.passed, true);
  assert.ok(seen.includes("task.completed"), "live subscribers still received events");
  assert.equal(entriesFor(started.task.id).length, orchestrator.events(started.task.id).length, "every entry is still held and readable");
  assert.equal(audit.health().writable, false);
  assert.ok(audit.health().pending > 0);
});
