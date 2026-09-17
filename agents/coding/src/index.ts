import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export const codingAgent: AgentDefinition = {
  id: "coding",
  name: "Coding Agent",
  capabilities: ["repository.analysis", "code.modification", "test.execution"],
  requiredPermissions: ["workspace.read", "workspace.write"]
};
