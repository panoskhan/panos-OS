import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext } from "../../packages/contracts/src/agent";
import type { PlanStep } from "../../agents/planner/src/index";
import { AgentRuntime, type ExecuteStepOptions, type RuntimeExecution } from "../../services/agents/src/runtime";
import { KhanOrchestrator, stubStepDelayMs } from "../../services/orchestrator/src/orchestrator";
import { gatedHandler, stepEvents, stepStarted, waitForEvent } from "../support/orchestration";

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

test("stub step delay is strictly zero in tests and ignores invalid values", () => {
  assert.equal(stubStepDelayMs(), 0);
  assert.equal(stubStepDelayMs({}), 0);
  assert.equal(stubStepDelayMs({ KHAN_STUB_STEP_DELAY_MS: "600" }), 600);
  assert.equal(stubStepDelayMs({ KHAN_STUB_STEP_DELAY_MS: "-5" }), 0);
  assert.equal(stubStepDelayMs({ KHAN_STUB_STEP_DELAY_MS: "soon" }), 0);
});

test("start returns immediately in executing before any step has finished", async () => {
  const gate = gatedHandler();
  const orchestrator = new KhanOrchestrator(undefined, undefined, gate.handler);

  const started = orchestrator.start(ANALYSIS_GOAL);

  assert.equal(started.task.status, "executing");
  assert.deepEqual(started.execution, []);
  assert.equal(started.plan.length, 3);

  await waitForEvent(orchestrator, started.task.id, stepStarted("inspect"));
  gate.releaseNext();
  await waitForEvent(orchestrator, started.task.id, stepStarted("analyze"));
  gate.releaseNext();
  assert.equal((await orchestrator.whenSettled(started.task.id)).task.status, "completed");
});

test("the task shows the running step while it is in progress", async () => {
  const gate = gatedHandler();
  const orchestrator = new KhanOrchestrator(undefined, undefined, gate.handler);
  const { task } = orchestrator.start(ANALYSIS_GOAL);

  await waitForEvent(orchestrator, task.id, stepStarted("inspect"));
  assert.deepEqual(
    orchestrator.get(task.id).execution.map((entry) => [entry.stepId, entry.status]),
    [["inspect", "running"]]
  );

  gate.releaseNext();
  await waitForEvent(orchestrator, task.id, stepStarted("analyze"));
  assert.deepEqual(
    orchestrator.get(task.id).execution.map((entry) => [entry.stepId, entry.status]),
    [["inspect", "completed"], ["analyze", "running"]]
  );

  gate.releaseNext();
  const settled = await orchestrator.whenSettled(task.id);
  assert.equal(settled.task.status, "completed");
  assert.deepEqual(settled.execution.map((entry) => [entry.stepId, entry.status]), [
    ["inspect", "completed"],
    ["analyze", "completed"],
    ["qa", "completed"]
  ]);
  assert.deepEqual(stepEvents(orchestrator.events(task.id)), [
    ["step.started", "inspect"],
    ["step.completed", "inspect"],
    ["step.started", "analyze"],
    ["step.completed", "analyze"],
    ["step.started", "qa"],
    ["step.completed", "qa"]
  ]);
});

test("run resolves at the approval gate and approve resumes in the background", async () => {
  const orchestrator = new KhanOrchestrator();

  const paused = await orchestrator.run(GITHUB_GOAL);
  assert.equal(paused.task.status, "waiting_approval");
  // A gated step never starts, so it is never shown as running.
  assert.deepEqual(stepEvents(orchestrator.events(paused.task.id)), [
    ["step.started", "inspect"],
    ["step.completed", "inspect"],
    ["step.waiting_approval", "implement"]
  ]);

  const approved = orchestrator.approve(paused.task.id);
  assert.equal(approved.task.status, "executing");

  const settled = await orchestrator.whenSettled(paused.task.id);
  assert.equal(settled.task.status, "completed");
  assert.deepEqual(settled.execution.map((entry) => [entry.stepId, entry.status]), [
    ["inspect", "completed"],
    ["implement", "completed"],
    ["test", "completed"],
    ["qa", "completed"]
  ]);
});

test("cancel during a running step records that step but starts no further steps", async () => {
  const gate = gatedHandler();
  const orchestrator = new KhanOrchestrator(undefined, undefined, gate.handler);
  const { task } = orchestrator.start(ANALYSIS_GOAL);

  await waitForEvent(orchestrator, task.id, stepStarted("inspect"));
  const cancelled = orchestrator.cancel(task.id, "Changed my mind");
  assert.equal(cancelled.task.status, "cancelled");

  gate.releaseNext();
  const settled = await orchestrator.whenSettled(task.id);
  assert.equal(settled.task.status, "cancelled");
  assert.deepEqual(settled.execution.map((entry) => [entry.stepId, entry.status]), [["inspect", "completed"]]);
  assert.deepEqual(settled.verification.checks, ["cancelled"]);
  assert.deepEqual(stepEvents(orchestrator.events(task.id)), [
    ["step.started", "inspect"],
    ["step.completed", "inspect"]
  ]);
});

test("a handler that throws fails the task with the error as a finding", async () => {
  const orchestrator = new KhanOrchestrator(undefined, undefined, async () => {
    throw new Error("model unavailable");
  });

  const report = await orchestrator.run(ANALYSIS_GOAL);

  assert.equal(report.task.status, "failed");
  assert.deepEqual(report.verification.checks, ["agent-execution"]);
  assert.deepEqual(report.verification.findings, ["model unavailable"]);
  assert.deepEqual(report.execution.map((entry) => [entry.stepId, entry.status]), [["inspect", "failed"]]);
});

test("an unexpected error in the background loop fails the task instead of crashing", async () => {
  class ExplodingRuntime extends AgentRuntime {
    override async executeStep(_step: PlanStep, _context: AgentContext, _options?: ExecuteStepOptions): Promise<RuntimeExecution> {
      throw new Error("runtime exploded");
    }
  }
  const orchestrator = new KhanOrchestrator(new ExplodingRuntime());

  const report = await orchestrator.run(ANALYSIS_GOAL);

  assert.equal(report.task.status, "failed");
  assert.deepEqual(report.verification.checks, ["internal-error"]);
  assert.deepEqual(report.verification.findings, ["runtime exploded"]);
});

test("whenSettled resolves immediately for a task that is not executing", async () => {
  const orchestrator = new KhanOrchestrator();
  const { task } = await orchestrator.run(ANALYSIS_GOAL);

  const settled = await orchestrator.whenSettled(task.id);

  assert.equal(settled.task.status, "completed");
});
