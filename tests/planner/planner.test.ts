import assert from "node:assert/strict";
import test from "node:test";
import { createPlan } from "../../agents/planner/src/index";

test("planner creates a dependency graph for analysis goals", () => {
  const plan = createPlan("Analyze the repository and identify the next engineering tasks.");

  assert.deepEqual(plan.map((step) => step.id), ["inspect", "analyze", "qa"]);
  assert.deepEqual(plan.map((step) => step.dependsOn), [[], ["inspect"], ["analyze"]]);
  assert.deepEqual(plan.map((step) => step.agent), ["coding", "coding", "qa"]);
});

test("planner changes the graph for implementation goals", () => {
  const plan = createPlan("Fix the permission engine bug and test the implementation.");

  assert.deepEqual(plan.map((step) => step.id), ["inspect", "implement", "test", "qa"]);
  assert.deepEqual(
    plan.map((step) => step.dependsOn),
    [[], ["inspect"], ["implement"], ["test"]]
  );
});

test("planner creates a testing graph for QA requests", () => {
  const plan = createPlan("Test the permission engine and verify the results.");

  assert.deepEqual(plan.map((step) => step.id), ["inspect", "test", "qa"]);
  assert.deepEqual(plan.map((step) => step.dependsOn), [[], ["inspect"], ["test"]]);
});

test("planner rejects an empty goal", () => {
  assert.throws(() => createPlan("   "), /Goal is required/);
});
