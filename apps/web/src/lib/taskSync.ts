import type { TaskEvent, TaskResponse } from "../../../../packages/contracts/src/api";
import { ApiRequestError, type KhanApiClient } from "./api";
import { isTerminal } from "./terminal";

/**
 * idle       nothing to watch (no task, the task finished, or it is gone)
 * connecting the event stream is opening or reconnecting
 * live       the event stream is open; updates arrive as the server emits them
 * polling    the stream is not live, so the task is being re-read on a timer
 */
export type Connection = "idle" | "connecting" | "live" | "polling";

/** The part of the browser's EventSource that TaskSync uses (injectable for other environments). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  close(): void;
}

export interface TaskSyncOptions {
  client: KhanApiClient;
  taskId: string;
  /** The task as last read. Step events are applied to it immediately, before the confirming read returns. */
  initialReport?: TaskResponse;
  /** Set when the task is already terminal, so replayed history does not trigger re-reads. */
  terminal?: boolean;
  /** How often to re-read the task while the stream is not live. */
  pollIntervalMs?: number;
  createEventSource?: (url: string) => EventSourceLike;
  onReport(report: TaskResponse): void;
  /** Called with the full, ordered, de-duplicated event list. */
  onEvents(events: TaskEvent[]): void;
  onConnection(connection: Connection): void;
  /** A message when reading the task failed, or null once a read succeeds again. */
  onError(message: string | null): void;
}

export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const TASK_GONE_MESSAGE = "This task no longer exists on the server (the API may have restarted).";

const browserEventSource = (url: string) => new EventSource(url) as unknown as EventSourceLike;

type StepStatus = TaskResponse["execution"][number]["status"];

// What a step event says about its step, and how far along each status is. A step only ever moves forward,
// so a late or repeated message can never undo something a newer read already showed.
const STEP_EVENT_STATUS: Partial<Record<TaskEvent["type"], StepStatus>> = {
  "step.waiting_approval": "waiting_approval",
  "step.started": "running",
  "step.completed": "completed",
  "step.failed": "failed"
};
const STEP_PROGRESS: Record<StepStatus, number> = { waiting_approval: 1, running: 2, completed: 3, failed: 3 };

/**
 * Keeps one task's report and event log up to date.
 *
 * The server emits an event after it has updated the task, so every event means "the task changed":
 * each one triggers a (coalesced) re-read of GET /v1/tasks/:id, and the UI never guesses a state.
 * If the event stream is not live, the task is polled instead: poll whenever the task is still
 * running and the stream is not open.
 */
export class TaskSync {
  private stopped = false;
  private ended = false;
  private terminal: boolean;
  private connection: Connection = "idle";
  private source?: EventSourceLike;
  private pollTimer?: ReturnType<typeof setInterval>;

  private events: TaskEvent[] = [];
  private lastSeq = 0;
  private flushScheduled = false;
  private latest?: TaskResponse;

  private running: Promise<void> | null = null;
  private rerun: Promise<void> | null = null;

  constructor(private readonly options: TaskSyncOptions) {
    this.latest = options.initialReport;
    this.terminal = options.terminal ?? (options.initialReport ? isTerminal(options.initialReport.task.status) : false);
  }

  start(): void {
    if (this.stopped || this.source || this.connection !== "idle") return;
    this.setConnection("connecting");
    // Started before the stream opens, but its first tick is a full interval away: a stream that
    // connects normally cancels it before it ever fires, so no poll request is sent.
    this.startPolling();

    try {
      const source = (this.options.createEventSource ?? browserEventSource)(this.options.client.eventsUrl(this.options.taskId));
      this.source = source;
      source.onopen = () => {
        this.stopPolling();
        this.setConnection("live");
        if (!this.terminal) void this.refresh(); // close any gap since the last read
      };
      source.onmessage = (message) => this.receive(message.data);
      source.addEventListener("end", () => this.handleEnd());
      source.onerror = () => this.handleStreamError();
    } catch {
      // No EventSource in this environment: polling carries on alone.
    }
  }

  stop(): void {
    this.stopped = true;
    this.source?.close();
    this.source = undefined;
    this.stopPolling();
  }

  /**
   * Re-reads the task. Calls made while a read is in flight share one follow-up read, so a burst of
   * events causes at most two reads. The returned promise settles after a read that started after this call.
   */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.running) {
      const read: Promise<void> = this.readReport().finally(() => {
        if (this.running === read) this.running = null;
      });
      this.running = read;
      return read;
    }
    if (!this.rerun) {
      this.rerun = this.running.then(() => {
        this.rerun = null;
        return this.refresh();
      });
    }
    return this.rerun;
  }

  private receive(data: string): void {
    let event: TaskEvent;
    try {
      event = JSON.parse(data) as TaskEvent;
    } catch {
      return; // ignore a malformed message
    }
    const isNew = event.seq > this.lastSeq;
    this.ingest([event]);
    if (isNew) this.applyStepEvent(event);
    if (!this.terminal) void this.refresh();
  }

  /**
   * Shows a step's new status the moment its event arrives, without waiting for the read that confirms it.
   * That read still runs and stays the authority (it also carries step output and the verification).
   */
  private applyStepEvent(event: TaskEvent): void {
    const report = this.latest;
    const status = STEP_EVENT_STATUS[event.type];
    const { stepId, agent } = event.data;
    if (!report || !status || this.terminal || typeof stepId !== "string" || typeof agent !== "string") return;
    if (!report.plan.some((step) => step.id === stepId)) return; // not in the plan yet: wait for the read

    const current = report.execution.find((entry) => entry.stepId === stepId);
    if (current && STEP_PROGRESS[current.status] >= STEP_PROGRESS[status]) return;

    const entry = { ...current, stepId, agent, status };
    const execution = current
      ? report.execution.map((existing) => (existing.stepId === stepId ? entry : existing))
      : [...report.execution, entry];
    this.latest = { ...report, execution };
    this.options.onReport(this.latest);
  }

  private handleEnd(): void {
    if (this.stopped) return;
    this.ended = true;
    this.source?.close(); // without this the browser would reconnect forever
    this.stopPolling();
    this.setConnection("idle");
    if (!this.terminal) void this.refresh();
  }

  private handleStreamError(): void {
    if (this.stopped || this.ended) return;
    if (this.terminal) {
      // A finished task only needs its log filled once.
      this.setConnection("idle");
      void this.readEvents();
      return;
    }
    // The browser retries a dropped stream by itself and resumes from the last event ID. Polling covers
    // the gap, and covers a stream that failed for good (an HTTP error, or a server without SSE).
    // Each failed retry raises another error; once polling has begun that must not flip the state back.
    if (this.connection !== "polling") this.setConnection("connecting");
    this.startPolling();
  }

  private async readReport(): Promise<void> {
    try {
      const report = await this.options.client.getTask(this.options.taskId);
      if (this.stopped) return;
      this.terminal = isTerminal(report.task.status);
      this.latest = report;
      this.options.onReport(report);
      this.options.onError(null);
      if (this.terminal && this.connection !== "live") {
        // Finished while the stream was not live. The report and the event log are read separately, so the
        // log may be a few events behind: read it one last time, then there is nothing left to wait for.
        this.stopPolling();
        this.source?.close();
        await this.readEvents();
        this.setConnection("idle");
      }
    } catch (error) {
      this.handleReadError(error);
    }
  }

  private async readEvents(): Promise<void> {
    try {
      const { events } = await this.options.client.getTaskEvents(this.options.taskId);
      if (!this.stopped) this.ingest(events);
    } catch (error) {
      this.handleReadError(error);
    }
  }

  private handleReadError(error: unknown): void {
    if (this.stopped) return;
    if (error instanceof ApiRequestError && error.status === 404) {
      this.stop();
      this.options.onConnection("idle");
      this.options.onError(TASK_GONE_MESSAGE);
      return;
    }
    this.options.onError(error instanceof Error ? error.message : String(error));
  }

  private startPolling(): void {
    if (this.pollTimer || this.terminal || this.stopped) return;
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.connection === "live") return;
    this.setConnection("polling");
    await Promise.all([this.refresh(), this.readEvents()]);
  }

  private ingest(incoming: TaskEvent[]): void {
    for (const event of incoming) {
      if (event.seq <= this.lastSeq) continue; // already have it (replay after a reconnect, or a poll)
      this.events.push(event);
      this.lastSeq = event.seq;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      if (!this.stopped) this.options.onEvents([...this.events]);
    });
  }

  private setConnection(next: Connection): void {
    if (this.stopped || this.connection === next) return;
    this.connection = next;
    this.options.onConnection(next);
  }
}
