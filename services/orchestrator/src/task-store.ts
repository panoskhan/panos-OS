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
}

/** In-memory task store. State is lost when the process exits. */
export class TaskStore {
  private readonly records = new Map<string, TaskRecord>();

  add(record: TaskRecord): void {
    const id = record.report.task.id;
    if (this.records.has(id)) throw new Error(`Task already exists: ${id}`);
    this.records.set(id, record);
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
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
    return event;
  }
}
