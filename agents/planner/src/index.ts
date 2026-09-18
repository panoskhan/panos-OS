import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export interface PlanStep {
  id: string;
  title: string;
  agent: "coding" | "qa";
  permissions: string[];
  dependsOn: string[];
}

type GoalKind = "analysis" | "implementation" | "testing";

export const plannerAgent: AgentDefinition = {
  id: "planner",
  name: "Planner Agent",
  capabilities: ["task.decomposition", "dependency.mapping", "risk.classification"],
  requiredPermissions: ["workspace.read"]
};

function classifyGoal(goal: string): GoalKind {
  const normalized = goal.toLowerCase();

  if (/\b(fix|bug|error|repair|implement|implementation|build|create|add|change|modify|refactor|update)\b/.test(normalized)) {
    return "implementation";
  }

  if (/\b(test|tests|testing|qa|verify|verification)\b/.test(normalized)) {
    return "testing";
  }

  return "analysis";
}

function requiresGithubWrite(goal: string): boolean {
  return /\b(github|push|publish|release)\b/.test(goal.toLowerCase());
}

function step(
  id: string,
  title: string,
  dependsOn: string[] = [],
  permissions: string[] = ["workspace.read"]
): PlanStep {
  return {
    id,
    title,
    agent: "coding",
    permissions,
    dependsOn
  };
}

export function createPlan(goal: string): PlanStep[] {
  const normalized = goal.trim();
  if (!normalized) throw new Error("Goal is required");

  const kind = classifyGoal(normalized);

  if (kind === "testing") {
    return [
      step("inspect", `Inspect the repository and identify what must be tested for: ${normalized}`),
      step("test", `Execute or prepare tests for: ${normalized}`, ["inspect"]),
      {
        id: "qa",
        title: "Independently QA the test results",
        agent: "qa",
        permissions: ["workspace.read"],
        dependsOn: ["test"]
      }
    ];
  }

  if (kind === "implementation") {
    const implementationPermissions = requiresGithubWrite(normalized)
      ? ["workspace.read", "workspace.write", "github.write"]
      : ["workspace.read", "workspace.write"];

    return [
      step("inspect", `Inspect the repository and identify implementation requirements for: ${normalized}`),
      step("implement", `Implement the required changes for: ${normalized}`, ["inspect"], implementationPermissions),
      step("test", `Test the implementation for: ${normalized}`, ["implement"]),
      {
        id: "qa",
        title: "Independently QA the implementation and test results",
        agent: "qa",
        permissions: ["workspace.read"],
        dependsOn: ["test"]
      }
    ];
  }

  return [
    step("inspect", `Inspect the repository for: ${normalized}`),
    step("analyze", `Analyze the repository and identify engineering tasks for: ${normalized}`, ["inspect"]),
    {
      id: "qa",
      title: "Independently QA the analysis and task graph",
      agent: "qa",
      permissions: ["workspace.read"],
      dependsOn: ["analyze"]
    }
  ];
}
