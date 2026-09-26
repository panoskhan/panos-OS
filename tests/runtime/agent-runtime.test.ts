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

test("agent runtime executes a registered agent", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "executed" }));

  const result = await runtime.executeStep(step(), context);

  assert.equal(result.status, "completed");
  assert.equal(result.output?.summary, "executed");
  assert.equal(result.permission.allowed, true);
});

test("agent runtime awaits async handlers", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", async () => {
    await Promise.resolve();
    return { status: "success", summary: "executed asynchronously" };
  });

  const result = await runtime.executeStep(step(), context);

  assert.equal(result.status, "completed");
  assert.equal(result.output?.summary, "executed asynchronously");
});

test("agent runtime turns a throwing handler into a failed result", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", async () => {
    throw new Error("disk on fire");
  });

  const result = await runtime.executeStep(step(), context);

  assert.equal(result.status, "failed");
  assert.equal(result.output?.status, "failure");
  assert.equal(result.output?.summary, "Agent 'coding' threw: disk on fire");
  assert.deepEqual(result.output?.findings, ["disk on fire"]);
});

test("agent runtime calls onStart only when the handler actually runs", async () => {
  const runtime = new AgentRuntime();
  const order: string[] = [];
  runtime.register("coding", () => {
    order.push("handler");
    return { status: "success", summary: "executed" };
  });
  const onStart = () => order.push("onStart");

  await runtime.executeStep(step(), context, { onStart });
  await runtime.executeStep(step({ permissions: ["github.write"] }), context, { onStart });
  await runtime.executeStep(step({ permissions: ["unknown.permission"] }), context, { onStart });
  await runtime.executeStep(step({ agent: "unknown" as PlanStep["agent"] }), context, { onStart });

  assert.deepEqual(order, ["onStart", "handler"]);
});

test("agent runtime stops when permission requires approval", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = await runtime.executeStep(
    step({ permissions: ["github.write"] }),
    context
  );

  assert.equal(result.status, "waiting_approval");
  assert.equal(result.permission.requiresApproval, true);
  assert.equal(result.output, undefined);
});

test("agent runtime executes an approval-gated step once its permission is approved", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "executed after approval" }));

  const result = await runtime.executeStep(
    step({ permissions: ["workspace.read", "github.write"] }),
    context,
    { approvedPermissions: ["github.write"] }
  );

  assert.equal(result.status, "completed");
  assert.equal(result.output?.summary, "executed after approval");
});

test("agent runtime approval does not grant unknown permissions", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = await runtime.executeStep(
    step({ permissions: ["unknown.permission"] }),
    context,
    { approvedPermissions: ["unknown.permission"] }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output, undefined);
});

test("agent runtime rejects denied permissions", async () => {
  const runtime = new AgentRuntime();
  runtime.register("coding", () => ({ status: "success", summary: "should not execute" }));

  const result = await runtime.executeStep(
    step({ permissions: ["unknown.permission"] }),
    context
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(result.permission.deniedPermissions, ["unknown.permission"]);
});

test("agent runtime reports unknown agents", async () => {
  const runtime = new AgentRuntime();

  const result = await runtime.executeStep(
    step({ agent: "unknown" as PlanStep["agent"] }),
    context
  );

  assert.equal(result.status, "failed");
  assert.equal(result.output?.summary, "Unknown agent: unknown");
});
