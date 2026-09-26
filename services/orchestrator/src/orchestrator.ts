import { randomUUID } from "node:crypto";
import type { AgentResult, AgentContext } from "../../../packages/contracts/src/agent";
import type { TaskEvent, TaskEventType } from "../../../packages/contracts/src/api";
import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { canTransition, transition } from "./state-machine";
import { TaskStore, type TaskRecord } from "./task-store";
import { plannerAgent, createPlan, type PlanStep } from "../../../agents/planner/src/index";
import { validatePlan } from "../../../agents/planner/src/validator";
import { codingAgent } from "../../../agents/coding/src/index";
import { qaAgent, describeQaFailures, verifyIndependentQa, type VerificationResult } from "../../../agents/qa/src/index";
import { AgentRuntime, type AgentHandler } from "../../agents/src/runtime";

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

export class TaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskStateError extends Error {
  constructor(readonly taskId: string, readonly status: TaskStatus, action: string) {
    super(`Cannot ${action} task ${taskId} in status '${status}'`);
    this.name = "InvalidTaskStateError";
  }
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

const pendingVerification = (): VerificationResult => ({ passed: false, checks: [], findings: [] });

export class KhanOrchestrator {
  private readonly runtime: AgentRuntime;
  private readonly planFactory: PlanFactory;
  private readonly store: TaskStore;

  constructor(
    runtime = new AgentRuntime(),
    planFactory: PlanFactory = createPlan,
    codingHandler: AgentHandler = defaultCodingHandler,
    store = new TaskStore()
  ) {
    this.runtime = runtime;
    this.planFactory = planFactory;
    this.store = store;

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

  /** Plans and executes a goal in one call. Kept for existing callers; equivalent to `start`. */
  run(goal: string): ExecutionReport {
    return this.start(goal);
  }

  /** Creates a task and executes it until it completes, fails or needs approval. */
  start(goal: string, projectId = "default"): ExecutionReport {
    const normalizedGoal = goal.trim();
    if (!normalizedGoal) throw new Error("Goal is required");

    const task: Task = {
      id: `task_${randomUUID()}`,
      projectId,
      goal: normalizedGoal,
      status: "received",
      risk: "read",
      requiredAgents: [plannerAgent.id, codingAgent.id, qaAgent.id],
      createdAt: new Date().toISOString()
    };
    const record: TaskRecord = {
      report: { task, plan: [], execution: [], verification: pendingVerification() },
      agentResults: [],
      completedSteps: new Set(),
      nextStepIndex: 0,
      approvedPermissions: new Set(),
      events: []
    };
    this.store.add(record);
    this.emit(record, "task.created", { goal: task.goal, projectId });

    this.setStatus(record, "understanding");
    this.setStatus(record, "planning");

    let plan: PlanStep[];
    try {
      plan = this.planFactory(task.goal);
    } catch (error) {
      return this.fail(record, {
        passed: false,
        checks: ["planning"],
        findings: [error instanceof Error ? error.message : String(error)]
      });
    }
    record.report.plan = plan;
    task.risk = classifyRisk(plan);
    this.emit(record, "plan.created", { steps: plan.map((step) => step.id), risk: task.risk });

    const validation = validatePlan(plan);
    if (!validation.valid) {
      return this.fail(record, { passed: false, checks: ["dependency-validation"], findings: validation.errors });
    }

    this.setStatus(record, "executing");
    return this.execute(record);
  }

  get(taskId: string): ExecutionReport {
    return this.snapshot(this.require(taskId));
  }

  events(taskId: string): TaskEvent[] {
    return structuredClone(this.require(taskId).events);
  }

  /** Grants the permissions of the step awaiting approval and resumes execution from that step. */
  approve(taskId: string): ExecutionReport {
    const record = this.require(taskId);
    const step = this.stepAwaitingApproval(record, "approve");
    for (const permission of step.permissions) record.approvedPermissions.add(permission);
    this.emit(record, "task.approved", { stepId: step.id, permissions: step.permissions });
    this.setStatus(record, "executing");
    return this.execute(record);
  }

  reject(taskId: string, reason?: string): ExecutionReport {
    const record = this.require(taskId);
    const step = this.stepAwaitingApproval(record, "reject");
    this.emit(record, "task.rejected", { stepId: step.id, permissions: step.permissions, ...(reason ? { reason } : {}) });
    return this.fail(record, {
      passed: false,
      checks: ["approval-rejected"],
      findings: [`Approval rejected for step: ${step.id}`, ...(reason ? [`Reason: ${reason}`] : [])]
    });
  }

  cancel(taskId: string, reason?: string): ExecutionReport {
    const record = this.require(taskId);
    const status = record.report.task.status;
    if (!canTransition(status, "cancelled")) throw new InvalidTaskStateError(taskId, status, "cancel");

    this.emit(record, "task.cancelled", reason ? { reason } : {});
    this.setStatus(record, "cancelled");
    record.report.verification = {
      passed: false,
      checks: ["cancelled"],
      findings: [`Task cancelled while ${status}`, ...(reason ? [`Reason: ${reason}`] : [])]
    };
    return this.snapshot(record);
  }

  private execute(record: TaskRecord): ExecutionReport {
    const { task, plan } = record.report;

    for (; record.nextStepIndex < plan.length; record.nextStepIndex++) {
      const step = plan[record.nextStepIndex];
      if (!step.dependsOn.every((dependency) => record.completedSteps.has(dependency))) {
        return this.fail(record, {
          passed: false,
          checks: ["dependency-order"],
          findings: [`Dependencies not completed for task: ${step.id}`]
        });
      }

      const context: AgentContext = {
        taskId: task.id,
        projectId: task.projectId,
        goal: task.goal,
        inputs: { agentResults: [...record.agentResults] }
      };
      const runtimeResult = this.runtime.executeStep(step, context, {
        approvedPermissions: record.approvedPermissions
      });
      this.recordExecution(record, {
        stepId: runtimeResult.stepId,
        agent: runtimeResult.agent,
        status: runtimeResult.status,
        output: runtimeResult.output
      });
      this.emit(record, `step.${runtimeResult.status}`, { stepId: step.id, agent: step.agent });

      if (runtimeResult.status === "waiting_approval") {
        this.setStatus(record, "waiting_approval");
        record.report.verification = { passed: false, checks: ["approval-required"], findings: step.permissions };
        return this.snapshot(record);
      }

      if (runtimeResult.status === "failed") {
        if (step.agent === qaAgent.id) {
          // Report the specific QA checks that rejected the prior agent results.
          return this.fail(record, { passed: false, ...describeQaFailures(record.agentResults, task.goal) });
        }
        return this.fail(record, {
          passed: false,
          checks: ["agent-execution"],
          findings: runtimeResult.output?.findings ?? [runtimeResult.output?.summary ?? "Agent execution failed"]
        });
      }

      if (step.agent === qaAgent.id) {
        // The QA agent independently verifies the results that existed before QA ran.
        // Do not include the QA result itself in the verification input.
        record.qaVerification = verifyIndependentQa(record.agentResults, task.goal);
      }

      record.completedSteps.add(step.id);
      if (runtimeResult.output) record.agentResults.push(runtimeResult.output);
    }

    this.setStatus(record, "verifying");
    const verification = record.qaVerification ?? verifyIndependentQa(record.agentResults, task.goal);
    record.report.verification = verification;
    this.setStatus(record, verification.passed ? "completed" : "failed");
    return this.snapshot(record);
  }

  /** Keeps one execution entry per step: a resumed step replaces its waiting_approval entry. */
  private recordExecution(record: TaskRecord, entry: ExecutionEntry): void {
    const execution = record.report.execution;
    const existing = execution.findIndex((item) => item.stepId === entry.stepId);
    if (existing === -1) execution.push(entry);
    else execution[existing] = entry;
  }

  private stepAwaitingApproval(record: TaskRecord, action: string): PlanStep {
    const { task, plan } = record.report;
    const step = plan[record.nextStepIndex];
    if (task.status !== "waiting_approval" || !step) throw new InvalidTaskStateError(task.id, task.status, action);
    return step;
  }

  private fail(record: TaskRecord, verification: VerificationResult): ExecutionReport {
    this.setStatus(record, "failed");
    record.report.verification = verification;
    return this.snapshot(record);
  }

  private setStatus(record: TaskRecord, to: TaskStatus): void {
    const from = record.report.task.status;
    record.report.task.status = transition(from, to);
    this.emit(record, "task.status_changed", { from, to });
  }

  private emit(record: TaskRecord, type: TaskEventType, data: Record<string, unknown> = {}): void {
    this.store.appendEvent(record, type, data);
  }

  private require(taskId: string): TaskRecord {
    const record = this.store.get(taskId);
    if (!record) throw new TaskNotFoundError(taskId);
    return record;
  }

  private snapshot(record: TaskRecord): ExecutionReport {
    return structuredClone(record.report);
  }
}
