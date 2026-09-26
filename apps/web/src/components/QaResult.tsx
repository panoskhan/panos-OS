import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { StatusBadge } from "./StatusBadge";

/** Independent QA outcome. Rendered once a task has reached a terminal state. */
export function QaResult({ report }: { report: TaskResponse }) {
  const { task, verification } = report;
  const [tone, label] = verification.passed
    ? ["passed", "QA PASS"]
    : task.status === "cancelled"
      ? ["cancelled", "CANCELLED"]
      : ["failed", "QA FAIL"];

  return (
    <section className="panel" data-outcome={tone} aria-labelledby="qa-title">
      <header className="panel-head">
        <h2 id="qa-title">Independent QA</h2>
        <StatusBadge status={tone} label={label} />
      </header>

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
