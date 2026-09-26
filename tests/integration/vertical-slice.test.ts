import assert from "node:assert/strict";
import test from "node:test";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { PermissionEngine } from "../../services/permissions/src/index";

test("vertical slice: request -> plan -> agents -> QA -> report", async () => {
  const report = await new KhanOrchestrator().run(
    "Analyze this project and identify the next engineering tasks."
  );

  assert.equal(report.task.status, "completed");
  assert.equal(report.plan.length, 3);
  assert.deepEqual(
    report.plan.map((step) => step.agent),
    ["coding", "coding", "qa"]
  );
  assert.deepEqual(
    report.plan.map((step) => step.dependsOn),
    [[], ["inspect"], ["analyze"]]
  );
  assert.equal(report.execution.length, 3);
  assert.equal(report.verification.passed, true);
  assert.deepEqual(report.verification.checks, [
    "agent-results-present",
    "agent-results-successful",
    "findings-present",
    "goal-referenced"
  ]);
  assert.ok(
    report.verification.findings.includes(
      "QA independently reviewed the execution results."
    )
  );
});

test("external permission requires an approval decision", () => {
  const decision = new PermissionEngine().decide(["github.write"]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresApproval, true);
  assert.deepEqual(decision.deniedPermissions, []);
});
