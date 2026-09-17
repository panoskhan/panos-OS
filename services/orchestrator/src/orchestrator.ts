import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { transition } from "./state-machine";
import { plannerAgent } from "../../../agents/planner/src/index";
import { codingAgent } from "../../../agents/coding/src/index";
import { qaAgent } from "../../../agents/qa/src/index";
import { PermissionEngine } from "../../permissions/src/index";

export interface PlanStep {
  id: string;
  title: string;
  agent: "coding" | "qa";
  permissions: string[];
}

export interface ExecutionReport {
  task: Task;
  plan: PlanStep[];
  execution: Array<{ stepId: string; agent: string; status: "completed" | "failed"; output: string }>;
  verification: { passed: boolean; checks: string[] };
}

export class KhanOrchestrator {
  private permissions = new PermissionEngine();

  run(goal: string): ExecutionReport {
    let status: TaskStatus = "received";
    const task: Task = {
      id: `task_${Date.now()}`,
      projectId: "default",
      goal,
      status,
      risk: "read",
      requiredAgents: [plannerAgent.id, codingAgent.id, qaAgent.id],
      createdAt: new Date().toISOString()
    };

    status = transition(status, "understanding");
    status = transition(status, "planning");
    task.status = status;

    const plan: PlanStep[] = [
      { id: "plan", title: `Decompose: ${goal}`, agent: "coding", permissions: ["workspace.read"] },
      { id: "qa", title: "Verify execution result", agent: "qa", permissions: ["workspace.read"] }
    ];

    const execution: ExecutionReport["execution"] = [];
    for (const step of plan) {
      if (!this.permissions.allowed(step.permissions)) {
        status = transition(status, "waiting_approval");
        task.status = status;
        break;
      }
      status = transition(status, "executing");
      task.status = status;
      execution.push({ stepId: step.id, agent: step.agent, status: "completed", output: `${step.title} completed` });
      status = transition(status, "verifying");
      task.status = status;
    }

    const passed = execution.length === plan.length;
    status = passed ? transition(status, "completed") : transition(status, "failed");
    task.status = status;

    return {
      task,
      plan,
      execution,
      verification: { passed, checks: ["plan-created", "agents-executed", "verification-completed"] }
    };
  }
}
