import type { TaskStatus } from "../../../../packages/contracts/src/task";

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** A terminal task never changes again, so nothing needs to keep watching it. */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
