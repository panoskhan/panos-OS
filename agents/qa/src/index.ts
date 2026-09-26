import type { AgentDefinition, AgentResult } from "../../../packages/contracts/src/agent";

export interface VerificationResult {
  passed: boolean;
  checks: string[];
  findings: string[];
}

export const qaAgent: AgentDefinition = {
  id: "qa",
  name: "QA Agent",
  capabilities: ["test.execution", "result.verification", "regression.analysis"],
  requiredPermissions: ["workspace.read"]
};

export function verifyAnalysis(results: AgentResult[]): VerificationResult {
  const findings = results.flatMap((result) => result.findings ?? []);
  const passed =
    results.length > 0 &&
    results.every((result) => result.status === "success") &&
    findings.length > 0;

  return {
    passed,
    checks: ["agent-result-present", "agent-results-successful", "findings-present"],
    findings
  };
}

function assessResults(results: AgentResult[], goal: string) {
  const findings = results.flatMap((result) => result.findings ?? []);
  return {
    present: results.length > 0,
    successful:
      results.length > 0 &&
      results.every((result) => result.status === "success"),
    hasFindings: findings.length > 0,
    findingCount: findings.length,
    goalReferenced:
      results.length > 0 &&
      results.every(
        (result) =>
          result.summary.includes(goal) ||
          (result.findings ?? []).some((finding) => finding.includes(goal))
      )
  };
}

/**
 * Names only the QA checks that failed, with one finding per failed check.
 * Used to report why independent QA rejected a task.
 */
export function describeQaFailures(
  results: AgentResult[],
  goal: string
): Pick<VerificationResult, "checks" | "findings"> {
  const assessment = assessResults(results, goal);
  if (!assessment.present) {
    return { checks: ["agent-results-present"], findings: ["No agent results were produced."] };
  }

  const checks: string[] = [];
  const findings: string[] = [];
  if (!assessment.successful) {
    checks.push("agent-results-successful");
    findings.push("One or more agent executions reported failure.");
  }
  if (!assessment.hasFindings) {
    checks.push("findings-present");
    findings.push("No findings were produced.");
  }
  if (!assessment.goalReferenced) {
    checks.push("agent-results-reference-goal");
    findings.push("At least one execution result does not reference the requested goal.");
  }
  return { checks, findings };
}

export function verifyIndependentQa(
  results: AgentResult[],
  goal: string
): VerificationResult {
  const { successful, hasFindings, findingCount, goalReferenced } = assessResults(results, goal);

  const checks = [
    "agent-results-present",
    "agent-results-successful",
    "findings-present",
    "goal-referenced"
  ];

  const qaFindings = [
    "QA independently reviewed the execution results.",
    successful
      ? "All agent executions reported success."
      : "One or more agent executions reported failure.",
    hasFindings
      ? `Reviewed ${findingCount} finding(s).`
      : "No findings were produced.",
    goalReferenced
      ? "Execution results reference the requested goal."
      : "Execution results do not reference the requested goal."
  ];

  return {
    passed: successful && hasFindings && goalReferenced,
    checks,
    findings: qaFindings
  };
}
