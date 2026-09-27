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
  | "permission.decided"
  | "qa.verdict"
  | "task.approved"
  | "task.rejected"
  | "task.cancelled"
  | "task.completed"
  | "task.failed";

/**
 * Who caused an event: "system" for the orchestrator's own decisions, "anonymous" for a request while the API
 * has no authentication. Phase 5d will name real callers here (for example "user:<id>").
 */
export type Actor = string;

export interface TaskEvent {
  seq: number;
  taskId: string;
  type: TaskEventType;
  at: string;
  actor: Actor;
  data: Record<string, unknown>;
}

export interface TaskEventsResponse {
  taskId: string;
  events: TaskEvent[];
}

export interface ApiError {
  error: string;
  detail?: string;
  /** Only on 429 rate_limited: how long to wait before trying again. */
  retryAfterMs?: number;
}

export type ComponentId = "orchestrator" | "model-router" | "agents" | "permissions" | "qa" | "audit" | "rate-limiter";

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

/** Everything in the task event vocabulary, plus entries the API layer records itself. */
export type AuditEntryType = TaskEventType | "request.refused";

/**
 * One line of the append-only audit log. `id` counts up across all tasks from 1. `hash` covers every other
 * field plus `prevHash`, so changing, removing or reordering any entry breaks the chain from that point on.
 */
export interface AuditEntry {
  id: number;
  at: string;
  taskId: string | null;
  type: AuditEntryType;
  actor: Actor;
  data: Record<string, unknown>;
  /** The previous entry's hash; 64 zeros for the first entry. */
  prevHash: string;
  hash: string;
}

export interface AuditPage {
  order: "asc" | "desc";
  limit: number;
  /** Pass as `cursor` to get the next page, or null when there is none. It is the id of the last entry returned. */
  nextCursor: string | null;
}

/** GET /v1/audit */
export interface AuditResponse {
  entries: AuditEntry[];
  page: AuditPage;
  /** How many entries match the filters, across all pages. */
  total: number;
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
