import assert from "node:assert/strict";
import test from "node:test";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

test("vertical slice: request -> plan -> agents -> QA -> report", () => {
  const report = new KhanOrchestrator().run("Analyze this project and identify the next engineering tasks.");

  assert.equal(report.task.status, "completed");
  assert.equal(report.plan.length, 2);
  assert.deepEqual(report.plan.map((step) => step.agent), ["coding", "qa"]);
  assert.equal(report.execution.length, 2);
  assert.equal(report.verification.passed, true);
  assert.ok(report.verification.findings.length >= 1);
});

test("external permission is not silently granted", () => {
  const report = new KhanOrchestrator().run("Prepare a GitHub push");
  assert.equal(report.task.status, "completed");
  assert.equal(report.verification.passed, true);
  assert.ok(report.plan.every((step) => step.permissions.includes("workspace.read")));
});
