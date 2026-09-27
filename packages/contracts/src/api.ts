import type { AgentResult } from "./agent";
import type { Task } from "./task";

export interface HealthResponse {
  status: "ok";
  service: string;
}

export interface ProjectInfoResponse {
  name: string;
  fileCount: number;
  language: string;
  lastUpdated: string | null;
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
