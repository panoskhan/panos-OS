import assert from "node:assert/strict";
import test from "node:test";
import { validatePlan } from "../../agents/planner/src/validator";
import type { PlanStep } from "../../agents/planner/src/index";

const step = (id: string, dependsOn: string[] = []): PlanStep => ({
  id,
  title: id,
  agent: "coding",
  permissions: ["workspace.read"],
  dependsOn
});

test("dependency validator accepts a valid graph", () => {
  const result = validatePlan([
    step("inspect"),
    step("implement", ["inspect"]),
    step("test", ["implement"]),
    { ...step("qa", ["test"]), agent: "qa" }
  ]);

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("dependency validator rejects a missing dependency", () => {
  const result = validatePlan([step("implement", ["inspect"])]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["Task implement depends on missing task: inspect"]);
});

test("dependency validator rejects self-dependency", () => {
  const result = validatePlan([step("inspect", ["inspect"])]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["Task inspect cannot depend on itself"]);
});

test("dependency validator rejects dependency cycles", () => {
  const result = validatePlan([
    step("a", ["b"]),
    step("b", ["a"])
  ]);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.startsWith("Dependency cycle detected:")));
});

test("dependency validator rejects duplicate task IDs", () => {
  const result = validatePlan([step("inspect"), step("inspect")]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ["Duplicate task ID: inspect"]);
});
