import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../../services/agents/src/runtime";
import type { PlanStep } from "../../agents/planner/src/index";

const context = {
  taskId: "task_test",
  projectId: "default",
  goal: "test runtime",
  inputs: {}
};

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: "inspect",
  title: "Inspect",
  agent: "coding",
  permissions: ["workspace.read"],
  dependsOn: [],
  ...overrides
});

test("agent runtime executes a registered agent", () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "executed" }));

  const result = runtime.executeStep(step(), context);

  assert.equal(result.status, "completed");
  assert.equal(result.output?.summary, "executed");
  assert.equal(result.permission.allowed, true);
});

test("agent runtime stops when permission requires approval", () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = runtime.executeStep(
    step({ permissions: ["github.write"] }),
    context
  );

  assert.equal(result.status, "waiting_approval");
  assert.equal(result.permission.requiresApproval, true);
  assert.equal(result.output, undefined);
});

test("agent runtime executes an approval-gated step once its permission is approved", () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "executed after approval" }));

  const result = runtime.executeStep(
    step({ permissions: ["workspace.read", "github.write"] }),
    context,
    { approvedPermissions: ["github.write"] }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output?.summary, "executed after approval");
});

test("agent runtime approval does not grant unknown permissions", () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = runtime.executeStep(
    step({ permissions: ["unknown.permission"] }),
    context,
    { approvedPermissions: ["unknown.permission"] }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output, undefined);
});

test("agent runtime rejects denied permissions", () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = runtime.executeStep(
    step({ permissions: ["unknown.permission"] }),
    context
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(result.permission.deniedPermissions, ["unknown.permission"]);
});

test("agent runtime reports unknown agents", () => {
  const runtime = new AgentRuntime();

  const result = runtime.executeStep(
    step({ agent: "unknown" as PlanStep["agent"] }),
    context
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output?.summary, "Unknown agent: unknown");
});
