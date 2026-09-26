import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { isTerminal } from "../hooks/useTask";
import { StatusBadge } from "./StatusBadge";

export function SystemReport({ report }: { report: TaskResponse | null }) {
  if (!report) {
    return (
      <section className="panel">
        <header className="panel-head">
          <h2>System report</h2>
        </header>
        <p className="empty">Verification results appear here once a task runs.</p>
      </section>
    );
  }

  const { task, plan, verification } = report;
  const [verdict, verdictLabel] = verification.passed
    ? ["passed", "QA PASS"]
    : task.status === "cancelled"
      ? ["cancelled", "CANCELLED"]
      : isTerminal(task.status)
        ? ["failed", "QA FAIL"]
        : ["waiting_approval", "QA PENDING"];

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>System report</h2>
        <StatusBadge status={verdict} label={verdictLabel} />
      </header>

      <div className="metrics">
        <div className="metric">
          <b>{plan.length}</b>
          <span>Steps</span>
        </div>
        <div className="metric">
          <b>{String(verification.passed)}</b>
          <span>Passed</span>
        </div>
        <div className="metric">
          <b>{task.risk}</b>
          <span>Risk</span>
        </div>
      </div>

      <dl className="report-meta">
        <dt>Task</dt>
        <dd><code>{task.id}</code></dd>
        <dt>Goal</dt>
        <dd>{task.goal}</dd>
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
