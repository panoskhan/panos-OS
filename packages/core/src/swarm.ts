/**
 * PANOS-OS Phase 7c — SWARM WARS
 * Several contenders attack the same problem at once and a judge declares a winner.
 *
 * Every contender is an ordinary task started through the orchestrator, so it goes through the same
 * state machine, permission engine and audit log as any other. The arena never approves a gate on a
 * contender's behalf: a problem that needs approval leaves every contender parked at the gate, and the
 * honest result is "no_winner", not a winner chosen by skipping the check.
 */

import { randomUUID } from "node:crypto";
import type { AgentResult } from "../../contracts/src/agent";
import type { Actor, TaskEvent } from "../../contracts/src/api";
import {
  SWARM_DEFAULT_SIZE,
  SWARM_MAX_SIZE,
  SWARM_MIN_SIZE,
  type Contender,
  type Swarm,
  type SwarmReport
} from "../../contracts/src/swarm";
import type { Task, TaskStatus } from "../../contracts/src/task";

export * from "../../contracts/src/swarm";

/** Only the slice of KhanOrchestrator that SwarmArena needs. */
export interface SwarmOrchestrator {
  start(goal: string, projectId?: string, actor?: Actor): { task: { id: string } };
  get(taskId: string): {
    task: Task;
    plan: unknown[];
    execution: { status: string; output?: AgentResult }[];
    verification: { passed: boolean };
  };
  events(taskId: string): TaskEvent[];
}

/** Contender labels, in the order they are fielded. They name a lane in the audit log; they do not change the task. */
export const STRATEGIES = ["minimalist", "thorough", "fastest", "skeptic", "scout", "builder", "reviewer", "wildcard"];

/** Statuses a contender can still leave without anyone's help. The others are rest states. */
const MOVING: ReadonlySet<TaskStatus> = new Set(["received", "understanding", "planning", "executing", "verifying"]);

export class SwarmArena {
  private readonly swarms = new Map<string, Swarm>();

  constructor(private readonly orchestrator: SwarmOrchestrator) {}

  /** Starts `size` contenders on one problem. Throws `problem_required` or `invalid_size`. */
  launch(problem: string, actor: string, size: number = SWARM_DEFAULT_SIZE): SwarmReport {
    const text = problem.trim();
    if (!text) throw new Error("problem_required");
    if (!Number.isInteger(size) || size < SWARM_MIN_SIZE || size > SWARM_MAX_SIZE) throw new Error("invalid_size");

    const contenders: Contender[] = [];
    for (const strategy of STRATEGIES.slice(0, size)) {
      const { task } = this.orchestrator.start(text, `swarm:${strategy}`, actor as Actor);
      contenders.push({
        strategy,
        taskId: task.id,
        status: "received",
        completedSteps: 0,
        totalSteps: 0,
        qaPassed: false,
        score: 0
      });
    }

    const swarm: Swarm = {
      id: `swarm_${randomUUID()}`,
      problem: text,
      actor,
      status: "running",
      createdAt: new Date().toISOString(),
      contenders
    };
    this.swarms.set(swarm.id, swarm);
    return { swarm: this.judge(swarm) };
  }

  /** The swarm as it stands now. Throws `swarm_not_found`. */
  get(id: string): SwarmReport {
    const swarm = this.swarms.get(id);
    if (!swarm) throw new Error("swarm_not_found");
    return { swarm: this.judge(swarm) };
  }

  list(): Swarm[] {
    return [...this.swarms.values()].map((swarm) => this.judge(swarm));
  }

  // ── Judging ────────────────────────────────────────────────────────────────

  /** Re-reads every contender from the orchestrator and recomputes the verdict. Pure of side effects on tasks. */
  private judge(swarm: Swarm): Swarm {
    for (const contender of swarm.contenders) this.refresh(contender);

    if (swarm.contenders.some((c) => MOVING.has(c.status))) {
      swarm.status = "running";
      delete swarm.winner;
      delete swarm.verdict;
      return structuredClone(swarm);
    }

    const finishers = swarm.contenders.filter((c) => c.status === "completed" && c.qaPassed);
    if (finishers.length === 0) {
      const parked = swarm.contenders.filter((c) => c.status === "waiting_approval").length;
      swarm.status = "no_winner";
      delete swarm.winner;
      swarm.verdict =
        parked > 0
          ? `${parked} of ${swarm.contenders.length} contenders stopped at the approval gate. The arena does not approve on their behalf, so nobody wins.`
          : `No contender finished with a passing QA check.`;
      return structuredClone(swarm);
    }

    // Highest score wins; ties go to whoever finished first, then to the earlier lane.
    const ranked = [...finishers].sort(
      (a, b) => b.score - a.score || this.finishedAt(a).localeCompare(this.finishedAt(b)) || STRATEGIES.indexOf(a.strategy) - STRATEGIES.indexOf(b.strategy)
    );
    swarm.status = "judged";
    swarm.winner = ranked[0].strategy;
    swarm.verdict = `${ranked[0].strategy} wins: ${finishers.length} of ${swarm.contenders.length} contenders finished, and it scored ${ranked[0].score} and finished first among the best.`;
    return structuredClone(swarm);
  }

  private refresh(contender: Contender): void {
    const report = this.orchestrator.get(contender.taskId);
    contender.status = report.task.status;
    contender.totalSteps = report.plan.length;
    contender.completedSteps = report.execution.filter((entry) => entry.status === "completed").length;
    contender.qaPassed = report.verification.passed;
    contender.score = score(contender);
  }

  private finishedAt(contender: Contender): string {
    const events = this.orchestrator.events(contender.taskId);
    return events.length ? events[events.length - 1].at : "";
  }
}

/**
 * One rubric for every contender, so a score means the same thing for all of them.
 * Finished and verified is the only way to reach 100. Parked at the gate earns a token 10, because it
 * stopped correctly but produced nothing. Anything still moving scores its progress, capped at 50.
 */
export function score(contender: Pick<Contender, "status" | "completedSteps" | "totalSteps" | "qaPassed">): number {
  switch (contender.status) {
    case "completed":
      return contender.qaPassed ? 100 : 40;
    case "failed":
    case "cancelled":
      return 0;
    case "waiting_approval":
      return 10;
    default:
      return contender.totalSteps > 0 ? Math.floor((50 * contender.completedSteps) / contender.totalSteps) : 0;
  }
}
