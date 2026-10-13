import type { TaskStatus } from "./task";

/** How many contenders one swarm may field. Four is the default; the cap keeps one request from flooding the orchestrator. */
export const SWARM_MIN_SIZE = 2;
export const SWARM_MAX_SIZE = 8;
export const SWARM_DEFAULT_SIZE = 4;

/**
 * "running": at least one contender can still make progress on its own.
 * "judged": every contender has settled and at least one finished, so there is a winner.
 * "no_winner": every contender has settled and none finished. The usual cause is the approval gate.
 */
export type SwarmStatus = "running" | "judged" | "no_winner";

export interface Contender {
  /** The strategy label, also the task's projectId ("swarm:<strategy>"), so the audit log can tell contenders apart. */
  strategy: string;
  taskId: string;
  status: TaskStatus;
  /** Plan steps that have finished, out of the plan's length. */
  completedSteps: number;
  totalSteps: number;
  qaPassed: boolean;
  /** 0-100. See SwarmArena for the rubric; it is the same for every contender. */
  score: number;
}

export interface Swarm {
  id: string;
  problem: string;
  actor: string;
  status: SwarmStatus;
  createdAt: string;
  contenders: Contender[];
  /** The winning contender's strategy. Only set once status is "judged". */
  winner?: string;
  /** One sentence saying why the swarm ended the way it did. */
  verdict?: string;
}

export interface SwarmReport {
  swarm: Swarm;
}
