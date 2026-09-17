import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export const qaAgent: AgentDefinition = {
  id: "qa",
  name: "QA Agent",
  capabilities: ["test.execution", "result.verification", "regression.analysis"],
  requiredPermissions: ["workspace.read"]
};
