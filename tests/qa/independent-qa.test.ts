import assert from "node:assert/strict";
import test from "node:test";
import { verifyIndependentQa } from "../../agents/qa/src/index";
import type { AgentResult } from "../../packages/contracts/src/agent";

test("independent QA rejects a failed agent result", () => {
  const goal = "Implement the next engineering task.";
  const results: AgentResult[] = [
    {
      status: "failure",
      summary: `Agent failed while handling goal: ${goal}`,
      findings: ["Agent execution failed."]
    }
  ];

  const verification = verifyIndependentQa(results, goal);

  assert.equal(verification.passed, false);
  assert.deepEqual(verification.checks, [
    "agent-results-present",
    "agent-results-successful",
    "findings-present",
    "goal-referenced"
  ]);
  assert.ok(
    verification.findings.includes(
      "One or more agent executions reported failure."
    )
  );
});

test("independent QA rejects results that do not reference the requested goal", () => {
  const goal = "Implement the next engineering task.";
  const results: AgentResult[] = [
    {
      status: "success",
      summary: "Agent completed an unrelated task.",
      findings: ["Unrelated finding."]
    }
  ];

  const verification = verifyIndependentQa(results, goal);

  assert.equal(verification.passed, false);
  assert.ok(
    verification.findings.includes(
      "Execution results do not reference the requested goal."
    )
  );
});
