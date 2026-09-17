import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export const plannerAgent: AgentDefinition = {
  id: "planner",
  name: "Planner Agent",
  capabilities: ["task.decomposition", "dependency.mapping", "risk.classification"],
  requiredPermissions: ["workspace.read"]
};
