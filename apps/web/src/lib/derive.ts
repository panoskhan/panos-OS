import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { TaskAction } from "../hooks/useTask";

export type AvatarState = "Ready" | "Thinking" | "Waiting Approval";

export interface StepCounts {
  total: number;
  completed: number;
  running: number;
  failed: number;
}

/** Step totals computed from the real plan and execution arrays. */
export function stepCounts(report: TaskResponse | null): StepCounts {
  const counts: StepCounts = { total: report?.plan.length ?? 0, completed: 0, running: 0, failed: 0 };
  for (const entry of report?.execution ?? []) {
    if (entry.status === "completed") counts.completed++;
    else if (entry.status === "running") counts.running++;
    else if (entry.status === "failed") counts.failed++;
  }
  return counts;
}

export function avatarState(report: TaskResponse | null, pending: TaskAction | null): AvatarState {
  const status = report?.task.status;
  if (status === "waiting_approval") return "Waiting Approval";
  if (pending === "create") return "Thinking";
  if (status && ["received", "understanding", "planning", "executing", "verifying"].includes(status)) return "Thinking";
  return "Ready";
}

/** Which orbital agents are doing something right now, derived from the task's real state. */
export function activeAgents(report: TaskResponse | null, pending: TaskAction | null): Set<string> {
  const active = new Set<string>();
  const status = report?.task.status;
  if (pending === "create" || status === "understanding" || status === "planning") active.add("planner");
  if (status === "waiting_approval") active.add("permissions");
  if (status === "verifying") active.add("qa");
  for (const entry of report?.execution ?? []) {
    if (entry.status === "running") active.add(entry.agent);
  }
  return active;
}

/** Plan steps that still need something to happen, derived from the real plan and execution state. */
export function nextTasks(report: TaskResponse | null): string[] {
  if (!report) return [];
  const { task, plan, execution } = report;
  const statusByStep = new Map(execution.map((entry) => [entry.stepId, entry.status]));
  const stopped = task.status === "failed" || task.status === "cancelled";

  const items: string[] = [];
  for (const step of plan) {
    const status = statusByStep.get(step.id);
    if (status === "completed" || status === "running") continue;
    if (status === "waiting_approval") items.push(`Approve or reject: ${step.title}`);
    else if (status === "failed") items.push(`Fix and re-run: ${step.title}`);
    else items.push(`${stopped ? "Not run" : "Queued"}: ${step.title}`);
  }
  return items;
}
