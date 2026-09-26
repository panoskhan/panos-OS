import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskEvent, TaskResponse } from "../../../../packages/contracts/src/api";
import { api, type KhanApiClient } from "../lib/api";
import { isTerminal } from "../lib/terminal";
import { TaskSync, type Connection } from "../lib/taskSync";

export { isTerminal };
export type { Connection };

export type TaskAction = "create" | "approve" | "reject" | "load";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The current task, kept live. A TaskSync (see lib/taskSync.ts) opens the task's event stream and
 * re-reads the task whenever the server reports a change, polling only if the stream is not live.
 */
export function useTask(client: KhanApiClient = api) {
  const [report, setReport] = useState<TaskResponse | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [connection, setConnection] = useState<Connection>("idle");
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pending, setPending] = useState<TaskAction | null>(null);
  // Bumped by every user action so a response from a superseded action can never overwrite a newer one.
  const generation = useRef(0);
  const syncRef = useRef<TaskSync | null>(null);
  const reportRef = useRef<TaskResponse | null>(null);

  useEffect(() => {
    reportRef.current = report;
  }, [report]);

  const taskId = report?.task.id;

  // One sync per open task: rebuilt only when the task changes, closed on cleanup (including React's dev double-mount).
  useEffect(() => {
    setEvents([]);
    setSyncError(null);
    if (!taskId) {
      setConnection("idle");
      return;
    }
    const sync = new TaskSync({
      client,
      taskId,
      initialReport: reportRef.current ?? undefined,
      onReport: (next) => setReport((current) => (current?.task.id === next.task.id ? next : current)),
      onEvents: setEvents,
      onConnection: setConnection,
      onError: setSyncError
    });
    syncRef.current = sync;
    sync.start();
    return () => {
      sync.stop();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [client, taskId]);

  const run = useCallback(async (action: TaskAction, call: () => Promise<TaskResponse | void>) => {
    const mine = ++generation.current;
    setPending(action);
    setActionError(null);
    try {
      const next = await call();
      if (generation.current === mine && next) setReport(next);
    } catch (error) {
      if (generation.current === mine) setActionError(errorMessage(error));
    } finally {
      if (generation.current === mine) setPending(null);
    }
  }, []);

  const createTask = useCallback(
    (goal: string) => run("create", () => client.createTask({ goal })),
    [client, run]
  );

  /** Opens an existing task (e.g. from recent tasks); it is watched live if it is still in progress. */
  const load = useCallback((id: string) => run("load", () => client.getTask(id)), [client, run]);

  // A decision's own response is a snapshot from the moment it was made. The stream may already have delivered
  // something newer, so the sync re-reads the task instead and that read is what updates the screen.
  const decide = useCallback(
    (action: "approve" | "reject", call: (id: string) => Promise<TaskResponse>) => {
      if (!taskId) return Promise.resolve();
      return run(action, async () => {
        const snapshot = await call(taskId);
        const sync = syncRef.current;
        if (!sync) return snapshot;
        await sync.refresh();
      });
    },
    [run, taskId]
  );

  const approve = useCallback(() => decide("approve", (id) => client.approveTask(id)), [client, decide]);
  const reject = useCallback(
    (reason?: string) => decide("reject", (id) => client.rejectTask(id, reason)),
    [client, decide]
  );

  return { report, events, connection, error: actionError ?? syncError, pending, createTask, load, approve, reject };
}
