import type { AgentResult } from "../../../packages/contracts/src/agent";
import type { TaskEvent, TaskEventType } from "../../../packages/contracts/src/api";
import type { VerificationResult } from "../../../agents/qa/src/index";
import type { ExecutionReport } from "./orchestrator";

/** Internal execution state for one task, including what is needed to resume it. */
export interface TaskRecord {
  report: ExecutionReport;
  agentResults: AgentResult[];
  completedSteps: Set<string>;
  nextStepIndex: number;
  approvedPermissions: Set<string>;
  qaVerification?: VerificationResult;
  events: TaskEvent[];
  /** The background execution loop, while one is running. */
  activeRun?: Promise<void>;
}

export type TaskEventListener = (event: TaskEvent) => void;

export interface TaskCounts {
  total: number;
  /** Tasks whose execution loop is running right now. */
  running: number;
  waitingApproval: number;
}

/** In-memory task store. State is lost when the process exits. */
export class TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Map<string, Set<TaskEventListener>>();

  add(record: TaskRecord): void {
    const id = record.report.task.id;
    if (this.records.has(id)) throw new Error(`Task already exists: ${id}`);
    this.records.set(id, record);
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  counts(): TaskCounts {
    let running = 0;
    let waitingApproval = 0;
    for (const record of this.records.values()) {
      if (record.activeRun) running++;
      if (record.report.task.status === "waiting_approval") waitingApproval++;
    }
    return { total: this.records.size, running, waitingApproval };
  }

  /** Registers a listener for events appended to one task. Returns an unsubscribe function. */
  subscribe(taskId: string, listener: TaskEventListener): () => void {
    let listeners = this.listeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(taskId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.listeners.get(taskId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(taskId);
    };
  }

  listenerCount(taskId: string): number {
    return this.listeners.get(taskId)?.size ?? 0;
  }

  appendEvent(record: TaskRecord, type: TaskEventType, data: Record<string, unknown> = {}): TaskEvent {
    const event: TaskEvent = {
      seq: record.events.length + 1,
      taskId: record.report.task.id,
      type,
      at: new Date().toISOString(),
      data
    };
    record.events.push(event);

    for (const listener of [...(this.listeners.get(event.taskId) ?? [])]) {
      // A failing listener (e.g. a dropped stream) must never break task execution.
      try {
        listener(structuredClone(event));
      } catch (error) {
        console.error(`Task event listener failed for ${event.taskId}:`, error);
      }
    }
    return event;
  }
}
