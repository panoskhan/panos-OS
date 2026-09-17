import type { AgentResult } from "../../../packages/contracts/src/agent";
import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { transition } from "./state-machine";
import { plannerAgent, createPlan, type PlanStep } from "../../../agents/planner/src/index";
import { codingAgent, executeAnalysis } from "../../../agents/coding/src/index";
import { qaAgent, verifyAnalysis, type VerificationResult } from "../../../agents/qa/src/index";
import { PermissionEngine } from "../../permissions/src/index";

export interface ExecutionEntry {
  stepId: string;
  agent: string;
  status: "completed" | "failed";
  output: AgentResult;
}

export interface ExecutionReport {
  task: Task;
  plan: PlanStep[];
  execution: ExecutionEntry[];
  verification: VerificationResult;
}

export class KhanOrchestrator {
  private permissions = new PermissionEngine();

  run(goal: string): ExecutionReport {
    let status: TaskStatus = "received";
    const task: Task = {
      id: `task_${Date.now()}`,
      projectId: "default",
      goal: goal.trim(),
      status,
      risk: "read",
      requiredAgents: [plannerAgent.id, codingAgent.id, qaAgent.id],
      createdAt: new Date().toISOString()
    };
    if (!task.goal) throw new Error("Goal is required");

    status = transition(status, "understanding");
    status = transition(status, "planning");
    task.status = status;
    const plan = createPlan(task.goal);
    const execution: ExecutionEntry[] = [];
    const agentResults: AgentResult[] = [];

    status = transition(status, "executing");
    task.status = status;
    for (const step of plan) {
      if (!this.permissions.allowed(step.permissions)) {
        status = transition(status, "waiting_approval");
        task.status = status;
        return { task, plan, execution, verification: { passed: false, checks: ["approval-required"], findings: step.permissions } };
      }

      let result: AgentResult;
      if (step.agent === codingAgent.id) {
        result = executeAnalysis(step, task.goal);
        agentResults.push(result);
      } else if (step.agent === qaAgent.id) {
        const verification = verifyAnalysis(agentResults);
        result = { status: verification.passed ? "success" : "failure", summary: verification.passed ? "QA passed" : "QA failed", findings: verification.findings };
      } else {
        result = { status: "failure", summary: `Unknown agent: ${step.agent}` };
      }

      execution.push({ stepId: step.id, agent: step.agent, status: result.status === "success" ? "completed" : "failed", output: result });
      if (result.status === "failure") {
        status = transition(status, "failed");
        task.status = status;
        return { task, plan, execution, verification: { passed: false, checks: ["agent-execution"], findings: result.findings ?? [result.summary] } };
      }
    }

    status = transition(status, "verifying");
    task.status = status;
    const verification = verifyAnalysis(agentResults);
    status = verification.passed ? transition(status, "completed") : transition(status, "failed");
    task.status = status;
    return { task, plan, execution, verification };
  }
}
