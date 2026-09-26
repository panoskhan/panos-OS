import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { TaskSummary } from "../hooks/useTaskHistory";
import { nextTasks } from "../lib/derive";
import { StatusBadge } from "./StatusBadge";

interface RightRailProps {
  report: TaskResponse | null;
  tasks: TaskSummary[];
  onSelect: (taskId: string) => void;
}

export function RightRail({ report, tasks, onSelect }: RightRailProps) {
  const activeId = report?.task.id;
  // While a task waits for approval the API puts the protected permission names in `findings`;
  // those aren't QA findings, so they are shown in the approval panel instead.
  const awaitingApproval = report?.verification.checks.includes("approval-required") ?? false;
  const findings = awaitingApproval ? [] : (report?.verification.findings ?? []);
  const next = nextTasks(report);

  return (
    <aside className="sidebar sidebar-right" aria-label="Task context">
      <section id="recent-tasks" tabIndex={-1} aria-labelledby="recent-title">
        <h2 id="recent-title" className="rail-title">Recent Tasks</h2>
        {tasks.length ? (
          <ul className="recent">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="recent-item"
                  aria-current={task.id === activeId ? "true" : undefined}
                  onClick={() => onSelect(task.id)}
                >
                  <span className="recent-goal">{task.goal}</span>
                  <span className="recent-meta">
                    <StatusBadge status={task.status} />
                    <time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleTimeString()}</time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">Tasks you run appear here.</p>
        )}
      </section>

      <section aria-labelledby="context-title">
        <h2 id="context-title" className="rail-title">Project Context</h2>
        {report ? (
          <dl className="context">
            <dt>Project</dt>
            <dd>{report.task.projectId}</dd>
            <dt>Task</dt>
            <dd><code>{report.task.id}</code></dd>
            <dt>Risk</dt>
            <dd className="keep-word">{report.task.risk}</dd>
            <dt>Agents</dt>
            <dd>{report.task.requiredAgents.join(", ")}</dd>
            <dt>Created</dt>
            <dd>{new Date(report.task.createdAt).toLocaleString()}</dd>
          </dl>
        ) : (
          <p className="empty">Run a task to see its project context.</p>
        )}
        <p className="note">Repository name, file count and language need a project endpoint, which the API doesn't have yet.</p>
      </section>

      <section aria-labelledby="findings-title">
        <h2 id="findings-title" className="rail-title">Key Findings</h2>
        {findings.length ? (
          <ul className="findings">
            {findings.map((finding, index) => (
              <li key={index}>{finding}</li>
            ))}
          </ul>
        ) : (
          <p className="empty">
            {awaitingApproval ? "QA runs after the gated step is approved." : "QA findings appear here once a task is verified."}
          </p>
        )}
      </section>

      <section aria-labelledby="next-title">
        <h2 id="next-title" className="rail-title">Next Recommended Tasks</h2>
        {next.length ? (
          <ul className="findings">
            {next.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="empty">{report ? "Nothing pending for this task." : "Steps still to do appear here."}</p>
        )}
      </section>
    </aside>
  );
}
