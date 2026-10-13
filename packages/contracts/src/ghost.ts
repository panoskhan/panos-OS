/**
 * PANOS-OS Phase 7a — Ghost Mode wire contract.
 *
 * The shapes and limits the API, the web app and the registry all agree on. Nothing here may import
 * from node:*, because the browser bundles this file: the runtime that owns timers and writes
 * ghosts.jsonl lives in packages/core/src/ghost.ts and re-exports everything below.
 */

/** The only schedule type for now; cron support planned for Phase 7b */
export interface IntervalSchedule {
  type: "interval";
  /** Milliseconds between automatic firings (minimum MIN_INTERVAL_MS) */
  ms: number;
}

export type GhostSchedule = IntervalSchedule;

export type GhostStatus = "active" | "paused" | "deleted";

export interface Ghost {
  id: string;
  goal: string;
  schedule: GhostSchedule;
  /** Actor who registered this ghost (flows through to audit log) */
  actor: string;
  status: GhostStatus;
  createdAt: string;
  /** ISO timestamp of the most recent automatic firing */
  lastFiredAt?: string;
  /** Running count of successful firings */
  fireCount: number;
}

export interface GhostReport {
  ghost: Ghost;
}

/** 5 s — prevents accidental tight loops in production. The registry refuses anything shorter. */
export const MIN_INTERVAL_MS = 5_000;
