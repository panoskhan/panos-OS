import type { TaskStatus } from "../../../packages/contracts/src/task";

const transitions: Record<TaskStatus, TaskStatus[]> = {
  received: ["understanding"],
  understanding: ["planning", "failed"],
  planning: ["waiting_approval", "executing", "failed"],
  waiting_approval: ["executing", "failed"],
  executing: ["verifying", "failed"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: ["planning"]
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
