import { randomUUID } from "node:crypto";
import type { AgentResult, AgentContext } from "../../../packages/contracts/src/agent";
import type { TaskEvent, TaskEventType } from "../../../packages/contracts/src/api";
import type { Task, TaskStatus } from "../../../packages/contracts/src/task";
import { canTransition, transition } from "./state-machine";
import { TaskStore, type TaskCounts, type TaskEventListener, type TaskRecord } from "./task-store";
import type { PermissionDecision } from "../../permissions/src/index";
import { plannerAgent, createPlan, type PlanStep } from "../../../agents/planner/src/index";
import { validatePlan } from "../../../agents/planner/src/validator";
import { codingAgent } from "../../../agents/coding/src/index";
import { qaAgent, verifyIndependentQa, type VerificationResult } from "../../../agents/qa/src/index";
import { AgentRuntime, type AgentHandler } from "../../agents/src/runtime";

export interface ExecutionEntry {
  stepId: string;
  agent: string;
  status: "running" | "completed" | "failed" | "waiting_approval";
  output?: AgentResult;
}

export interface ExecutionReport {
  task: Task;
  plan: PlanStep[];
  execution: ExecutionEntry[];
  verification: VerificationResult;
}

/** A read-only view of the live orchestrator, for health checks. */
export interface OrchestratorDiagnostics {
  registeredAgents: string[];
  permissions: { decide(required: string[]): PermissionDecision };
  tasks: TaskCounts;
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

/**
 * STUB TIMING ONLY. The built-in coding and QA handlers are stubs that finish instantly;
 * KHAN_STUB_STEP_DELAY_MS makes them wait so step-by-step progress is visible in demos.
 * It is not real work. Missing, zero, negative or non-numeric values mean no delay.
 */
export function stubStepDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const delay = Number(env.KHAN_STUB_STEP_DELAY_MS);
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

async function stubDelay(): Promise<void> {
  const delay = stubStepDelayMs();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

const defaultCodingHandler: AgentHandler = async (step, context) => {
  await stubDelay();
  return {
    status: "success",
    summary: `Executed coding agent step '${step.id}' for goal: ${context.goal}`,
    findings: [
      `Coding agent executed task: ${step.title}`
    ]
  };
};

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

    this.runtime.register(qaAgent.id, async (_step, context) => {
      await stubDelay();
      const results = (context.inputs.agentResults as AgentResult[] | undefined) ?? [];
      const verification = verifyIndependentQa(results, context.goal);
      return {
        status: verification.passed ? "success" : "failure",
        summary: verification.passed ? "QA passed" : "QA failed",
        findings: verification.findings
      };
    });
  }

  /** Plans and executes a goal, resolving once it completes, fails or needs approval. */
  async run(goal: string): Promise<ExecutionReport> {
    const { task } = this.start(goal);
    return this.whenSettled(task.id);
  }

  /**
   * Creates and plans a task, then starts executing it in the background.
   * Returns immediately with the task in `executing` (or `failed` if planning failed).
   */
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
    return this.launch(record);
  }

  get(taskId: string): ExecutionReport {
    return this.snapshot(this.require(taskId));
  }

  /** The live agent handlers, permission engine and task counts, for health checks. Changes nothing. */
  diagnostics(): OrchestratorDiagnostics {
    return {
      registeredAgents: this.runtime.registeredAgents(),
      permissions: this.runtime.permissionEngine,
      tasks: this.store.counts()
    };
  }

  events(taskId: string): TaskEvent[] {
    return structuredClone(this.require(taskId).events);
  }

  /** Listens for new events on one task. Returns an unsubscribe function. */
  subscribe(taskId: string, listener: TaskEventListener): () => void {
    this.require(taskId);
    return this.store.subscribe(taskId, listener);
  }

  /**
   * Resolves once no execution loop is running for the task, i.e. it has completed,
   * failed, been cancelled, or is waiting for approval.
   */
  async whenSettled(taskId: string): Promise<ExecutionReport> {
    const record = this.require(taskId);
    while (record.activeRun) await record.activeRun;
    return this.snapshot(record);
  }

  /** Grants the permissions of the step awaiting approval and resumes execution from that step in the background. */
  approve(taskId: string): ExecutionReport {
    const record = this.require(taskId);
    const step = this.stepAwaitingApproval(record, "approve");
    for (const permission of step.permissions) record.approvedPermissions.add(permission);
    this.emit(record, "task.approved", { stepId: step.id, permissions: step.permissions });
    this.setStatus(record, "executing");
    return this.launch(record);
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

  /**
   * Cancels the task. If a step is running, it finishes and its result is recorded,
   * but no further steps start.
   */
  cancel(taskId: string, reason?: string): ExecutionReport {
    const record = this.require(taskId);
    const status = record.report.task.status;
    if (!canTransition(status, "cancelled")) throw new InvalidTaskStateError(taskId, status, "cancel");

    this.emit(record, "task.cancelled", reason ? { reason } : {});
    record.report.verification = {
      passed: false,
      checks: ["cancelled"],
      findings: [`Task cancelled while ${status}`, ...(reason ? [`Reason: ${reason}`] : [])]
    };
    this.setStatus(record, "cancelled");
    return this.snapshot(record);
  }

  /** Starts the execution loop in the background and returns the task as it is now. */
  private launch(record: TaskRecord): ExecutionReport {
    const snapshot = this.snapshot(record);
    const run: Promise<void> = this.execute(record)
      .catch((error: unknown) => this.failUnexpectedly(record, error))
      .finally(() => {
        if (record.activeRun === run) record.activeRun = undefined;
      });
    record.activeRun = run;
    return snapshot;
  }

  private async execute(record: TaskRecord): Promise<void> {
    const { task, plan } = record.report;

    for (; record.nextStepIndex < plan.length; record.nextStepIndex++) {
      if (this.isCancelled(record)) return;

      const step = plan[record.nextStepIndex];
      if (!step.dependsOn.every((dependency) => record.completedSteps.has(dependency))) {
        this.fail(record, {
          passed: false,
          checks: ["dependency-order"],
          findings: [`Dependencies not completed for task: ${step.id}`]
        });
        return;
      }

      const context: AgentContext = {
        taskId: task.id,
        projectId: task.projectId,
        goal: task.goal,
        inputs: { agentResults: [...record.agentResults] }
      };
      const runtimeResult = await this.runtime.executeStep(step, context, {
        approvedPermissions: record.approvedPermissions,
        onStart: () => {
          this.recordExecution(record, { stepId: step.id, agent: step.agent, status: "running" });
          this.emit(record, "step.started", { stepId: step.id, agent: step.agent });
        }
      });

      // A gated step never ran, so there is nothing to record once the task is cancelled.
      if (this.isCancelled(record) && runtimeResult.status === "waiting_approval") return;

      this.recordExecution(record, {
        stepId: runtimeResult.stepId,
        agent: runtimeResult.agent,
        status: runtimeResult.status,
        output: runtimeResult.output
      });
      this.emit(record, `step.${runtimeResult.status}`, { stepId: step.id, agent: step.agent });

      // A step that was already running when the task was cancelled is recorded above; nothing further starts.
      if (this.isCancelled(record)) return;

      if (runtimeResult.status === "waiting_approval") {
        record.report.verification = { passed: false, checks: ["approval-required"], findings: step.permissions };
        this.setStatus(record, "waiting_approval");
        return;
      }

      if (runtimeResult.status === "failed") {
        if (step.agent === qaAgent.id) {
          // A failed QA result is itself a valid negative verification outcome.
          // Preserve the independent QA contract instead of collapsing it into
          // the generic agent-execution failure shape.
          this.fail(record, verifyIndependentQa(record.agentResults, task.goal));
          return;
        }
        this.fail(record, {
          passed: false,
          checks: ["agent-execution"],
          findings: runtimeResult.output?.findings ?? [runtimeResult.output?.summary ?? "Agent execution failed"]
        });
        return;
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
    record.report.verification = record.qaVerification ?? verifyIndependentQa(record.agentResults, task.goal);
    this.setStatus(record, record.report.verification.passed ? "completed" : "failed");
  }

  /** Last-resort handler for errors escaping the execution loop, so a background run can never crash the process. */
  private failUnexpectedly(record: TaskRecord, error: unknown): void {
    if (!canTransition(record.report.task.status, "failed")) return;
    this.fail(record, {
      passed: false,
      checks: ["internal-error"],
      findings: [error instanceof Error ? error.message : String(error)]
    });
  }

  private isCancelled(record: TaskRecord): boolean {
    return record.report.task.status === "cancelled";
  }

  /** Keeps one execution entry per step: a later status for the same step replaces the earlier one. */
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

  // Verification is set before the status change so listeners reacting to the
  // status event always read a consistent report.
  private fail(record: TaskRecord, verification: VerificationResult): ExecutionReport {
    record.report.verification = verification;
    this.setStatus(record, "failed");
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
