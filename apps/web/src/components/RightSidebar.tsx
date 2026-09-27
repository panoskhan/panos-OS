import type { ProjectInfoResponse, TaskResponse } from "../../../../packages/contracts/src/api";
import type { TaskHistoryEntry } from "../hooks/useTaskHistory";
import { StatusBadge } from "./StatusBadge";

interface RightSidebarProps {
  history: TaskHistoryEntry[];
  activeTaskId?: string;
  onSelectTask: (id: string) => void;
  selecting: boolean;
  projectInfo: ProjectInfoResponse | null;
  projectError: string | null;
  report: TaskResponse | null;
  onRecommend: (goal: string) => void;
}

function formatBytesTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function RightSidebar({
  history,
  activeTaskId,
  onSelectTask,
  selecting,
  projectInfo,
  projectError,
  report,
  onRecommend
}: RightSidebarProps) {
  const findings = report?.verification.findings ?? [];

  return (
    <aside className="sidebar-right">
      <section className="panel">
        <header className="panel-head">
          <h2>Recent Tasks</h2>
          <span className="muted">{history.length}</span>
        </header>
        {history.length === 0 ? (
          <p className="empty">Tasks you run appear here.</p>
        ) : (
          <ul className="task-list">
            {history.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="task-item"
                  data-active={entry.id === activeTaskId}
                  disabled={selecting && entry.id !== activeTaskId}
                  onClick={() => onSelectTask(entry.id)}
                >
                  <span className="task-item-goal" title={entry.goal}>{entry.goal}</span>
                  <span className="task-item-meta">
                    <StatusBadge status={entry.status} />
                    <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString()}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Project Context</h2>
        </header>
        {projectError ? (
          <p className="error-text">{projectError}</p>
        ) : !projectInfo ? (
          <p className="empty">Loading project context…</p>
        ) : (
          <dl className="context-meta">
            <dt>Repo</dt>
            <dd><code>{projectInfo.name}</code></dd>
            <dt>Files</dt>
            <dd>{projectInfo.fileCount.toLocaleString()}</dd>
            <dt>Language</dt>
            <dd>{projectInfo.language}</dd>
            <dt>Updated</dt>
            <dd>{projectInfo.lastUpdated ? formatBytesTime(projectInfo.lastUpdated) : "—"}</dd>
          </dl>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Key Findings</h2>
        </header>
        {findings.length === 0 ? (
          <p className="empty">Findings from the latest QA verification appear here.</p>
        ) : (
          <ul className="findings">
            {findings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Next Recommended Tasks</h2>
        </header>
        {findings.length === 0 ? (
          <p className="empty">Suggestions from QA findings appear here.</p>
        ) : (
          <ul className="recommend-list">
            {findings.map((finding, index) => (
              <li key={index}>
                <button type="button" className="recommend-item" onClick={() => onRecommend(`Follow up: ${finding}`)}>
                  {finding}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
