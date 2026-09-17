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
  const passed = results.length > 0 && results.every((result) => result.status === "success") && findings.length > 0;
  return {
    passed,
    checks: ["agent-result-present", "agent-results-successful", "findings-present"],
    findings
  };
}
