/**
 * PANOS-OS Phase 7a (interval) + Phase 7b (cron) — Ghost Mode
 * Background agent registry: register standing goals that fire automatically
 * on a schedule without requiring a human "Hey KHAN" prompt each time.
 *
 * The shapes live in packages/contracts and are re-exported here, so a browser can import the
 * contract without pulling in the node:* modules this file needs to own timers and a data file.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MIN_INTERVAL_MS,
  nextCronFire,
  parseCron,
  type Ghost,
  type GhostReport,
  type GhostSchedule,
} from "../../contracts/src/ghost";

export * from "../../contracts/src/ghost";

// ─── Minimal orchestrator interface ──────────────────────────────────────────

/** Only the slice of KhanOrchestrator that GhostRegistry needs */
export interface GhostOrchestrator {
  start(goal: string, projectId?: string, actor?: string): { task: { id: string } };
}

// ─── GhostRegistry ───────────────────────────────────────────────────────────

export class GhostRegistry {
  private readonly ghosts = new Map<string, Ghost>();
  /** Holds either a setInterval handle (interval ghosts) or a setTimeout handle (cron ghosts). */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dataFile: string;

  constructor(
    private readonly orchestrator: GhostOrchestrator,
    dataDir = "data",
    /** Lowest interval this registry accepts. Overridden in tests so they need no real waiting. */
    private readonly minIntervalMs: number = MIN_INTERVAL_MS
  ) {
    this.dataFile = path.join(dataDir, "ghosts.jsonl");
    this._load();
    // Re-activate ghosts that were active before a restart
    for (const ghost of this.ghosts.values()) {
      if (ghost.status === "active") this._startTimer(ghost);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  register(goal: string, schedule: GhostSchedule, actor: string): GhostReport {
    // Validate schedule by type
    if (schedule.type === "interval") {
      if (schedule.ms < this.minIntervalMs) {
        throw new Error(`interval_too_short: minimum is ${this.minIntervalMs}ms`);
      }
    } else {
      // cron: validate the expression is parseable before we persist anything
      try {
        parseCron(schedule.expression);
      } catch (err) {
        throw new Error(`cron_invalid: ${(err as Error).message}`);
      }
      const next = nextCronFire(schedule.expression, new Date(), schedule.tz);
      if (!next) {
        throw new Error("cron_no_future_fire: expression never fires within 4 years");
      }
    }

    const ghost: Ghost = {
      id: randomUUID(),
      goal,
      schedule,
      actor,
      status: "active",
      createdAt: new Date().toISOString(),
      fireCount: 0,
    };

    // Stamp the first scheduled fire time
    ghost.nextFireAt = this._nextFireAt(ghost);

    this.ghosts.set(ghost.id, ghost);
    this._startTimer(ghost);
    this._persist(ghost);
    return { ghost };
  }

  pause(id: string): GhostReport {
    const ghost = this._require(id);
    if (ghost.status === "deleted") throw new Error("ghost_deleted");
    if (ghost.status === "paused") return { ghost };
    ghost.status = "paused";
    this._stopTimer(id);
    this._persist(ghost);
    return { ghost };
  }

  resume(id: string): GhostReport {
    const ghost = this._require(id);
    if (ghost.status === "deleted") throw new Error("ghost_deleted");
    if (ghost.status === "active") return { ghost };
    ghost.status = "active";
    ghost.nextFireAt = this._nextFireAt(ghost);
    this._startTimer(ghost);
    this._persist(ghost);
    return { ghost };
  }

  remove(id: string): GhostReport {
    const ghost = this._require(id);
    ghost.status = "deleted";
    ghost.nextFireAt = undefined;
    this._stopTimer(id);
    this._persist(ghost);
    return { ghost };
  }

  get(id: string): GhostReport {
    return { ghost: this._require(id) };
  }

  list(): Ghost[] {
    return Array.from(this.ghosts.values()).filter(
      (g) => g.status !== "deleted"
    );
  }

  /** Graceful shutdown — clears all timers */
  close(): void {
    for (const id of [...this.timers.keys()]) this._stopTimer(id);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _require(id: string): Ghost {
    const ghost = this.ghosts.get(id);
    if (!ghost) throw new Error("ghost_not_found");
    return ghost;
  }

  /** Compute the ISO string for the next fire of this ghost (from now). */
  private _nextFireAt(ghost: Ghost): string | undefined {
    if (ghost.schedule.type === "interval") {
      return new Date(Date.now() + ghost.schedule.ms).toISOString();
    }
    const next = nextCronFire(ghost.schedule.expression, new Date(), ghost.schedule.tz);
    return next?.toISOString();
  }

  private _startTimer(ghost: Ghost): void {
    this._stopTimer(ghost.id);

    if (ghost.schedule.type === "interval") {
      const timer = setInterval(() => this._fire(ghost.id), ghost.schedule.ms);
      if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === "function") {
        (timer as NodeJS.Timeout & { unref: () => void }).unref();
      }
      this.timers.set(ghost.id, timer);
      return;
    }

    // cron: setTimeout to the next firing, then reschedule after each fire
    this._scheduleCronFire(ghost);
  }

  /**
   * Arm a one-shot setTimeout to the next cron fire.
   * After it fires we re-arm immediately, so the ghost always has one pending timer.
   */
  private _scheduleCronFire(ghost: Ghost): void {
    const next = nextCronFire(ghost.schedule.expression, new Date(), ghost.schedule.tz);
    if (!next) {
      // Expression never fires again (e.g. a past date-specific cron). Retire silently.
      return;
    }
    const delayMs = Math.max(0, next.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(ghost.id);           // clear before fire so _stopTimer no-ops cleanly
      this._fire(ghost.id);
      // Re-arm only if ghost is still active
      const g = this.ghosts.get(ghost.id);
      if (g && g.status === "active") this._scheduleCronFire(g);
    }, delayMs);
    if (typeof (timer as NodeJS.Timeout & { unref?: () => void }).unref === "function") {
      (timer as NodeJS.Timeout & { unref: () => void }).unref();
    }
    this.timers.set(ghost.id, timer);
    // Keep nextFireAt fresh in the in-memory ghost
    ghost.nextFireAt = next.toISOString();
  }

  private _stopTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      // clearTimeout works for both setTimeout and setInterval handles in Node
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  private _fire(id: string): void {
    const ghost = this.ghosts.get(id);
    if (!ghost || ghost.status !== "active") return;
    try {
      this.orchestrator.start(ghost.goal, "ghost", ghost.actor);
      ghost.fireCount++;
      ghost.lastFiredAt = new Date().toISOString();
      this._persist(ghost);
    } catch {
      // Suppress — ghost keeps running even if orchestrator rejects (e.g. rate limit)
    }
  }

  private _persist(ghost: Ghost): void {
    try {
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      fs.appendFileSync(this.dataFile, JSON.stringify(ghost) + "\n", "utf-8");
    } catch {
      // Non-fatal: in-memory map is authoritative; disk is a reload-optimisation
    }
  }

  private _load(): void {
    try {
      const raw = fs.readFileSync(this.dataFile, "utf-8");
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const g = JSON.parse(line) as Ghost;
          if (g.id) this.ghosts.set(g.id, g);
        } catch {
          /* skip malformed lines */
        }
      }
    } catch {
      /* no data file yet — start fresh */
    }
  }
}
