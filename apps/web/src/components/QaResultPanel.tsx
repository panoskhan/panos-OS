import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { isTerminal } from "../hooks/useTask";
import { StatusBadge } from "./StatusBadge";

/** Shown once a task has settled (completed, failed or cancelled) with its independent QA verdict. */
export function QaResultPanel({ report }: { report: TaskResponse | null }) {
  if (!report || !isTerminal(report.task.status)) return null;

  const { task, verification } = report;
  const [status, label] = verification.passed
    ? ["passed", "QA PASS"]
    : task.status === "cancelled"
      ? ["cancelled", "CANCELLED"]
      : ["failed", "QA FAIL"];

  return (
    <section className="panel qa-panel" data-passed={verification.passed}>
      <header className="panel-head">
        <h2>QA Result</h2>
        <StatusBadge status={status} label={label} />
      </header>

      <dl className="report-meta">
        <dt>Task</dt>
        <dd><code>{task.id}</code></dd>
        <dt>Goal</dt>
        <dd>{task.goal}</dd>
        <dt>Risk</dt>
        <dd>{task.risk}</dd>
      </dl>

      <h3>Checks</h3>
      {verification.checks.length ? (
        <ul className="tags">
          {verification.checks.map((check) => (
            <li key={check}>{check}</li>
          ))}
        </ul>
      ) : (
        <p className="empty">No checks recorded.</p>
      )}

      <h3>Findings</h3>
      {verification.findings.length ? (
        <ul className="findings">
          {verification.findings.map((finding, index) => (
            <li key={index}>{finding}</li>
          ))}
        </ul>
      ) : (
        <p className="empty">No findings recorded.</p>
      )}
    </section>
  );
}
