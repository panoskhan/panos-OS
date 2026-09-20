import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult } from "../../packages/contracts/src/agent";
import type { PlanStep } from "../../agents/planner/src/index";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

const analysisPlan = (_goal: string): PlanStep[] => [
  {
    id: "analyze",
    title: "Analyze the requested project",
    agent: "coding",
    permissions: ["workspace.read"],
    dependsOn: []
  },
  {
    id: "qa",
    title: "Independently QA the analysis",
    agent: "qa",
    permissions: ["workspace.read"],
    dependsOn: ["analyze"]
  }
];

test("negative path: independent QA rejects an invalid coding result", () => {
  const goal = "Analyze the requested project.";
  const invalidResult: AgentResult = {
    status: "success",
    summary: "Completed successfully",
    findings: ["This finding deliberately does not reference the requested goal."]
  };

  const report = new KhanOrchestrator(
    undefined,
    analysisPlan,
    () => invalidResult
  ).run(goal);

  assert.equal(report.execution[0]?.status, "completed");
  assert.equal(report.execution[0]?.output?.status, "success");
  assert.equal(report.task.status, "failed");
  assert.equal(report.verification.passed, false);
  assert.deepEqual(report.verification.checks, [
    "agent-results-present",
    "agent-results-successful",
    "findings-present",
    "goal-referenced"
  ]);
  assert.equal(
    report.verification.findings[3],
    "Execution results do not reference the requested goal."
  );
  assert.equal(report.execution.some((entry) => entry.stepId === "qa"), true);
});
