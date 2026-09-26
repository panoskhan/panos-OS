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
