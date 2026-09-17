import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export interface PlanStep {
  id: string;
  title: string;
  agent: "coding" | "qa";
  permissions: string[];
  dependsOn: string[];
}

export const plannerAgent: AgentDefinition = {
  id: "planner",
  name: "Planner Agent",
  capabilities: ["task.decomposition", "dependency.mapping", "risk.classification"],
  requiredPermissions: ["workspace.read"]
};

export function createPlan(goal: string): PlanStep[] {
  const normalized = goal.trim();
  if (!normalized) throw new Error("Goal is required");

  return [
    {
      id: "analyze",
      title: `Analyze project and identify engineering tasks for: ${normalized}`,
      agent: "coding",
      permissions: ["workspace.read"],
      dependsOn: []
    },
    {
      id: "qa",
      title: "QA the analysis and task plan",
      agent: "qa",
      permissions: ["workspace.read"],
      dependsOn: ["analyze"]
    }
  ];
}
