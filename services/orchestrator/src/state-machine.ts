import type { TaskStatus } from "../../../packages/contracts/src/task";

const transitions: Record<TaskStatus, TaskStatus[]> = {
  received: ["understanding", "cancelled"],
  understanding: ["planning", "failed", "cancelled"],
  planning: ["waiting_approval", "executing", "failed", "cancelled"],
  waiting_approval: ["executing", "failed", "cancelled"],
  executing: ["verifying", "waiting_approval", "failed", "cancelled"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: ["planning"],
  cancelled: []
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function transition(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
  return to;
}
