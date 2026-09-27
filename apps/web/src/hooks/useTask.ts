import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { TaskStatus } from "../../../../packages/contracts/src/task";
import { api, type KhanApiClient } from "../lib/api";

export const POLL_INTERVAL_MS = 1000;

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "cancelled"]);

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export type TaskAction = "create" | "approve" | "reject" | "select";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTask(client: KhanApiClient = api) {
  const [report, setReport] = useState<TaskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<TaskAction | null>(null);
  // Bumped by every user action so a response started earlier (a poll or a
  // superseded action) can never overwrite a newer result.
  const generation = useRef(0);

  const taskId = report?.task.id;
  const status = report?.task.status;
  const polling = status !== undefined && !isTerminal(status);

  useEffect(() => {
    if (!taskId || !polling) return;
    let active = true;
    let inFlight = false;

    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      const startedAt = generation.current;
      try {
        const next = await client.getTask(taskId);
        if (active && generation.current === startedAt) {
          setReport(next);
          setError(null);
        }
      } catch (pollError) {
        if (active && generation.current === startedAt) setError(errorMessage(pollError));
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, taskId, polling]);

  const run = useCallback(async (action: TaskAction, call: () => Promise<TaskResponse>) => {
    const mine = ++generation.current;
    setPending(action);
    setError(null);
    try {
      const next = await call();
      if (generation.current === mine) setReport(next);
    } catch (actionError) {
      if (generation.current === mine) setError(errorMessage(actionError));
    } finally {
      if (generation.current === mine) setPending(null);
    }
  }, []);

  const createTask = useCallback(
    (goal: string) => run("create", () => client.createTask({ goal })),
    [client, run]
  );

  const approve = useCallback(async () => {
    if (taskId) await run("approve", () => client.approveTask(taskId));
  }, [client, run, taskId]);

  const reject = useCallback(
    async (reason?: string) => {
      if (taskId) await run("reject", () => client.rejectTask(taskId, reason));
    },
    [client, run, taskId]
  );

  const selectTask = useCallback(
    (id: string) => run("select", () => client.getTask(id)),
    [client, run]
  );

  return { report, error, pending, polling, createTask, approve, reject, selectTask };
}
