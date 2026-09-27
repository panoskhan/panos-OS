import { useEffect, useState } from "react";
import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { RiskLevel, TaskStatus } from "../../../../packages/contracts/src/task";

export interface TaskHistoryEntry {
  id: string;
  goal: string;
  status: TaskStatus;
  risk: RiskLevel;
  createdAt: string;
}

const STORAGE_KEY = "khan-os.task-history";
const MAX_ENTRIES = 20;

function load(): TaskHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TaskHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: TaskHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage may be unavailable (private browsing, quota); history just won't persist.
  }
}

/**
 * Tracks tasks this browser has actually created or viewed, sourced entirely from real
 * TaskResponse payloads returned by the API. Persisted to localStorage so the list survives
 * a reload; nothing here is fabricated, it's just a client-side accumulation of real responses.
 */
export function useTaskHistory(report: TaskResponse | null) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>(load);

  useEffect(() => {
    if (!report) return;
    setEntries((current) => {
      const next: TaskHistoryEntry = {
        id: report.task.id,
        goal: report.task.goal,
        status: report.task.status,
        risk: report.task.risk,
        createdAt: report.task.createdAt
      };
      const without = current.filter((entry) => entry.id !== next.id);
      const updated = [next, ...without].slice(0, MAX_ENTRIES);
      save(updated);
      return updated;
    });
  }, [report]);

  return entries;
}
