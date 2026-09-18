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

export function verifyIndependentQa(
  results: AgentResult[],
  goal: string
): VerificationResult {
  const findings = results.flatMap((result) => result.findings ?? []);
  const successful =
    results.length > 0 &&
    results.every((result) => result.status === "success");
  const hasFindings = findings.length > 0;
  const goalReferenced =
    results.length > 0 &&
    results.every(
      (result) =>
        result.summary.includes(goal) ||
        (result.findings ?? []).some((finding) => finding.includes(goal))
    );

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
      ? `Reviewed ${findings.length} finding(s).`
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
