import type { AgentResult } from "./agent";
import type { Task } from "./task";

export interface HealthResponse {
  status: "ok";
  service: string;
}

export interface CreateTaskRequest {
  goal: string;
  projectId?: string;
}

export interface TaskDecisionRequest {
  reason?: string;
}

export interface PlanStepView {
  id: string;
  title: string;
  agent: string;
  permissions: string[];
  dependsOn: string[];
}

export interface ExecutionEntryView {
  stepId: string;
  agent: string;
  status: "running" | "completed" | "failed" | "waiting_approval";
  output?: AgentResult;
}

export interface VerificationView {
  passed: boolean;
  checks: string[];
  findings: string[];
}

export interface TaskResponse {
  task: Task;
  plan: PlanStepView[];
  execution: ExecutionEntryView[];
  verification: VerificationView;
}

export type TaskEventType =
  | "task.created"
  | "task.status_changed"
  | "plan.created"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.waiting_approval"
  | "task.approved"
  | "task.rejected"
  | "task.cancelled";

export interface TaskEvent {
  seq: number;
  taskId: string;
  type: TaskEventType;
  at: string;
  data: Record<string, unknown>;
}

export interface TaskEventsResponse {
  taskId: string;
  events: TaskEvent[];
}

export interface ApiError {
  error: string;
  detail?: string;
}

export type ComponentId = "orchestrator" | "model-router" | "agents" | "permissions" | "qa";

/**
 * up             the component's self-test passed
 * down           the component's self-test failed
 * not_configured the component exists in the design but nothing in the system uses it yet
 */
export type ComponentState = "up" | "down" | "not_configured";

export interface ComponentStatus {
  id: ComponentId;
  name: string;
  state: ComponentState;
  /** What was checked and what was found, in plain words. */
  detail: string;
  metrics?: Record<string, number>;
}

/** GET /v1/status. Always HTTP 200; a failing component shows up as `degraded`. */
export interface StatusResponse {
  /** "degraded" when any component is down. A not_configured component does not degrade it. */
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
  checkedAt: string;
  components: ComponentStatus[];
}
