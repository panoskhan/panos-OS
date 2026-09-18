import assert from "node:assert/strict";
import test from "node:test";
import type { PlanStep } from "../../agents/planner/src/index";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

const approvalPlan = (_goal: string): PlanStep[] => [
  {
    id: "inspect",
    title: "Inspect the repository",
    agent: "coding",
    permissions: ["workspace.read"],
    dependsOn: []
  },
  {
    id: "publish",
    title: "Publish the requested change",
    agent: "coding",
    permissions: ["github.write"],
    dependsOn: ["inspect"]
  },
  {
    id: "qa",
    title: "Independently QA the execution",
    agent: "qa",
    permissions: ["workspace.read"],
    dependsOn: ["publish"]
  }
];

test("vertical slice stops before an approval-gated agent executes", () => {
  const goal = "Publish the requested change.";
  const report = new KhanOrchestrator(undefined, approvalPlan).run(goal);

  assert.equal(report.task.status, "waiting_approval");
  assert.equal(report.task.risk, "external");
  assert.deepEqual(
    report.execution.map((entry) => [entry.stepId, entry.status]),
    [
      ["inspect", "completed"],
      ["publish", "waiting_approval"]
    ]
  );
  assert.equal(report.execution.some((entry) => entry.stepId === "qa"), false);
  assert.equal(report.verification.passed, false);
  assert.deepEqual(report.verification.checks, ["approval-required"]);
  assert.deepEqual(report.verification.findings, ["github.write"]);
});

test("real planner marks GitHub implementation as external and stops before the write", () => {
  const goal = "Implement the fix and push the changes to GitHub.";
  const report = new KhanOrchestrator().run(goal);

  assert.equal(report.task.status, "waiting_approval");
  assert.equal(report.task.risk, "external");
  assert.deepEqual(
    report.execution.map((entry) => [entry.stepId, entry.status]),
    [
      ["inspect", "completed"],
      ["implement", "waiting_approval"]
    ]
  );
  assert.equal(report.execution.some((entry) => entry.stepId === "test"), false);
  assert.equal(report.execution.some((entry) => entry.stepId === "qa"), false);
  assert.deepEqual(report.verification.checks, ["approval-required"]);
  assert.deepEqual(report.verification.findings, ["workspace.read", "workspace.write", "github.write"]);
});
