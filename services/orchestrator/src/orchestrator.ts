import type { AgentResult, AgentContext } from "../../../packages/contracts/src/agent";
import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { transition } from "./state-machine";
import { plannerAgent, createPlan, type PlanStep } from "../../../agents/planner/src/index";
import { validatePlan } from "../../../agents/planner/src/validator";
import { codingAgent } from "../../../agents/coding/src/index";
import { qaAgent, verifyIndependentQa, type VerificationResult } from "../../../agents/qa/src/index";
import { AgentRuntime, type AgentHandler, type RuntimeExecution as RuntimeExecutionEntry } from "../../agents/src/runtime";

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

type PlanFactory = (goal: string) => PlanStep[];

function classifyRisk(plan: PlanStep[]): Task["risk"] {
  if (plan.some((step) => step.permissions.includes("github.write") || step.permissions.includes("publish.external"))) {
    return "external";
  }
  if (plan.some((step) => step.permissions.includes("workspace.write"))) {
    return "low";
  }
  return "read";
}

const defaultCodingHandler: AgentHandler = (step, context) => ({
  status: "success",
  summary: `Executed coding agent step '${step.id}' for goal: ${context.goal}`,
  findings: [
    `Coding agent executed task: ${step.title}`
  ]
});

export class KhanOrchestrator {
  private readonly runtime: AgentRuntime;
  private readonly planFactory: PlanFactory;

  constructor(
    runtime = new AgentRuntime(),
    planFactory: PlanFactory = createPlan,
    codingHandler: AgentHandler = defaultCodingHandler
  ) {
    this.runtime = runtime;
    this.planFactory = planFactory;

    this.runtime.register(codingAgent.id, codingHandler);

    this.runtime.register(qaAgent.id, (_step, context) => {
      const results = (context.inputs.agentResults as AgentResult[] | undefined) ?? [];
      const verification = verifyIndependentQa(results, context.goal);
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
    const plan = this.planFactory(task.goal);
    task.risk = classifyRisk(plan);
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
    let independentQaVerification: VerificationResult | undefined;

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

        // A failed QA result is itself a valid negative verification outcome.
        // Preserve the independent QA contract instead of collapsing it into
        // the generic agent-execution failure shape.
        const verification = step.agent === qaAgent.id
          ? verifyIndependentQa(agentResults, task.goal)
          : {
              passed: false,
              checks: ["agent-execution"],
              findings: runtimeResult.output?.findings ?? [runtimeResult.output?.summary ?? "Agent execution failed"]
            };

        return {
          task,
          plan,
          execution,
          verification
        };
      }

      if (step.agent === qaAgent.id) {
        // The QA agent independently verifies the results that existed before QA ran.
        // Do not include the QA result itself in the verification input.
        independentQaVerification = verifyIndependentQa(agentResults, task.goal);
      }

      completed.add(step.id);
      if (runtimeResult.output) agentResults.push(runtimeResult.output);
    }

    status = transition(status, "verifying");
    task.status = status;
    const verification = independentQaVerification ?? verifyIndependentQa(agentResults, task.goal);
    status = verification.passed ? transition(status, "completed") : transition(status, "failed");
    task.status = status;
    return { task, plan, execution, verification };
  }
}
