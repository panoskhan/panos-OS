import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentResult } from "../../../packages/contracts/src/agent";
import type { TaskEvent } from "../../../packages/contracts/src/api";
import type { VerificationResult } from "../../../agents/qa/src/index";
import type { ExecutionReport } from "./orchestrator";
import type { TaskRecord } from "./task-store";

/** A task record as stored: the sets become arrays and the running loop is dropped. */
export interface StoredTask {
  report: ExecutionReport;
  agentResults: AgentResult[];
  completedSteps: string[];
  nextStepIndex: number;
  approvedPermissions: string[];
  qaVerification?: VerificationResult;
  events: TaskEvent[];
}

/** Where task records are kept between restarts. */
export interface TaskPersistence {
  /** Every stored task. Called once at startup. */
  load(): TaskRecord[];
  /** Stores the current state of one task. */
  save(record: TaskRecord): void;
  /** Where the tasks live, for the startup message. */
  readonly location: string;
}

export function toStored(record: TaskRecord): StoredTask {
  return structuredClone({
    report: record.report,
    agentResults: record.agentResults,
    completedSteps: [...record.completedSteps],
    nextStepIndex: record.nextStepIndex,
    approvedPermissions: [...record.approvedPermissions],
    qaVerification: record.qaVerification,
    events: record.events
  });
}

export function fromStored(stored: StoredTask): TaskRecord {
  return {
    report: stored.report,
    agentResults: stored.agentResults,
    completedSteps: new Set(stored.completedSteps),
    nextStepIndex: stored.nextStepIndex,
    approvedPermissions: new Set(stored.approvedPermissions),
    qaVerification: stored.qaVerification,
    events: stored.events
  };
}

/**
 * Keeps all tasks in one JSON file, rewritten atomically (temp file, then rename) after every change,
 * so a crash mid-write can never leave a half-written file behind. Fine for a single local server;
 * it rewrites the whole file each time, so it is not meant for thousands of tasks.
 */
export class FileTaskPersistence implements TaskPersistence {
  private readonly tasks = new Map<string, StoredTask>();

  constructor(private readonly file: string) {}

  get location(): string {
    return this.file;
  }

  load(): TaskRecord[] {
    if (!existsSync(this.file)) return [];
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { version?: number; tasks?: StoredTask[] };
    if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
      throw new Error(`Task file ${this.file} is not a version 1 task file`);
    }
    for (const stored of parsed.tasks) this.tasks.set(stored.report.task.id, stored);
    return parsed.tasks.map(fromStored);
  }

  save(record: TaskRecord): void {
    this.tasks.set(record.report.task.id, toStored(record));
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }));
    renameSync(temp, this.file);
  }
}
