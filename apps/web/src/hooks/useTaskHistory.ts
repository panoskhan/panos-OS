import { useCallback, useEffect, useState } from "react";
import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { RiskLevel, TaskStatus } from "../../../../packages/contracts/src/task";
import { ApiRequestError, api, type KhanApiClient } from "../lib/api";

const STORAGE_KEY = "khan.recentTaskIds";
const MAX_TASKS = 12;

export interface TaskSummary {
  id: string;
  goal: string;
  status: TaskStatus;
  risk: RiskLevel;
  createdAt: string;
}

function summarize({ task }: TaskResponse): TaskSummary {
  return { id: task.id, goal: task.goal, status: task.status, risk: task.risk, createdAt: task.createdAt };
}

// The API has no "list tasks" endpoint, so this browser remembers the IDs it has seen.
// Everything shown about a task (goal, status, risk) is fetched from the real API.
function readIds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_TASKS) : [];
  } catch {
    return [];
  }
}

function writeIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); history just isn't remembered.
  }
}

/** Recent tasks, newest first. `current` is folded in as it changes so statuses stay live. */
export function useTaskHistory(current: TaskResponse | null, client: KhanApiClient = api): TaskSummary[] {
  const [ids, setIds] = useState<string[]>(readIds);
  const [summaries, setSummaries] = useState<Record<string, TaskSummary>>({});

  const forget = useCallback((id: string) => {
    setIds((previous) => {
      const next = previous.filter((existing) => existing !== id);
      writeIds(next);
      return next;
    });
  }, []);

  // Load the remembered tasks once. Tasks the API no longer knows (e.g. after a restart) are dropped.
  useEffect(() => {
    let active = true;
    for (const id of readIds()) {
      client.getTask(id).then(
        (response) => active && setSummaries((known) => ({ ...known, [id]: summarize(response) })),
        (error: unknown) => {
          if (active && error instanceof ApiRequestError && error.status === 404) forget(id);
        }
      );
    }
    return () => {
      active = false;
    };
  }, [client, forget]);

  useEffect(() => {
    if (!current) return;
    const id = current.task.id;
    setSummaries((known) => ({ ...known, [id]: summarize(current) }));
    setIds((previous) => {
      if (previous[0] === id) return previous;
      const next = [id, ...previous.filter((existing) => existing !== id)].slice(0, MAX_TASKS);
      writeIds(next);
      return next;
    });
  }, [current]);

  return ids.flatMap((id) => (summaries[id] ? [summaries[id]] : []));
}
