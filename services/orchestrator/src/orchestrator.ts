import type { AgentResult, AgentContext } from "../../../packages/contracts/src/agent";
import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { transition } from "./state-machine";
import { plannerAgent, createPlan, type PlanStep } from "../../../agents/planner/src/index";
import { validatePlan } from "../../../agents/planner/src/validator";
import { codingAgent } from "../../../agents/coding/src/index";
import { qaAgent, verifyAnalysis, type VerificationResult } from "../../../agents/qa/src/index";
import { AgentRuntime, type RuntimeExecution as RuntimeExecutionEntry } from "../../agents/src/runtime";

export interface ExecutionEntry {
  stepId: string;
  agent: string;
  status: "completed" | "failed" | "waiting_approval";
  output?: AgentResult;
}

export interface ExecutionReport {
  task: Task;
  plan: PlanStep[];
  execution: ExecutionEntry[];
  verification: VerificationResult;
}

export class KhanOrchestrator {
  private readonly runtime = new AgentRuntime();

  constructor() {
    this.runtime.register(codingAgent.id, (step, context) => {
      return {
        status: "success",
        summary: `Executed coding agent step '${step.id}' for goal: ${context.goal}`,
        findings: [
          `Coding agent executed task: ${step.title}`
        ]
      };
    });

    this.runtime.register(qaAgent.id, (_step, context) => {
      const results = (context.inputs.agentResults as AgentResult[] | undefined) ?? [];
      const verification = verifyAnalysis(results);
      return {
        status: verification.passed ? "success" : "failure",
        summary: verification.passed ? "QA passed" : "QA failed",
        findings: verification.findings
      };
    });
  }

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
    const validation = validatePlan(plan);

    if (!validation.valid) {
      status = transition(status, "failed");
      task.status = status;
      return {
        task,
        plan,
        execution: [],
        verification: {
          passed: false,
          checks: ["dependency-validation"],
          findings: validation.errors
        }
      };
    }

    const execution: ExecutionEntry[] = [];
    const agentResults: AgentResult[] = [];
    const completed = new Set<string>();

    status = transition(status, "executing");
    task.status = status;

    for (const step of plan) {
      const dependenciesReady = step.dependsOn.every((dependency) => completed.has(dependency));
      if (!dependenciesReady) {
        status = transition(status, "failed");
        task.status = status;
        return {
          task,
          plan,
          execution,
          verification: {
            passed: false,
            checks: ["dependency-order"],
            findings: [`Dependencies not completed for task: ${step.id}`]
          }
        };
      }

      const context: AgentContext = {
        taskId: task.id,
        projectId: task.projectId,
        goal: task.goal,
        inputs: { agentResults: [...agentResults] }
      };
      const runtimeResult: RuntimeExecutionEntry = this.runtime.executeStep(step, context);
      execution.push({
        stepId: runtimeResult.stepId,
        agent: runtimeResult.agent,
        status: runtimeResult.status,
        output: runtimeResult.output
      });

      if (runtimeResult.status === "waiting_approval") {
        status = transition(status, "waiting_approval");
        task.status = status;
        return {
          task,
          plan,
          execution,
          verification: {
            passed: false,
            checks: ["approval-required"],
            findings: step.permissions
          }
        };
      }

      if (runtimeResult.status === "failed") {
        status = transition(status, "failed");
        task.status = status;
        return {
          task,
          plan,
          execution,
          verification: {
            passed: false,
            checks: ["agent-execution"],
            findings: runtimeResult.output?.findings ?? [runtimeResult.output?.summary ?? "Agent execution failed"]
          }
        };
      }

      completed.add(step.id);
      if (runtimeResult.output) agentResults.push(runtimeResult.output);
    }

    status = transition(status, "verifying");
    task.status = status;
    const verification = verifyAnalysis(agentResults);
    status = verification.passed ? transition(status, "completed") : transition(status, "failed");
    task.status = status;
    return { task, plan, execution, verification };
  }
}
