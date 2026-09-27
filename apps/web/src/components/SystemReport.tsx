import type { TaskResponse } from "../../../../packages/contracts/src/api";

export function SystemReport({ report }: { report: TaskResponse | null }) {
  const total = report?.plan.length ?? 0;
  const completed = report?.execution.filter((entry) => entry.status === "completed").length ?? 0;
  const running = report?.execution.filter((entry) => entry.status === "running").length ?? 0;
  const failed = report?.execution.filter((entry) => entry.status === "failed").length ?? 0;

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>System Report</h2>
        {!report && <span className="muted">READY</span>}
      </header>
      <div className="metrics-report">
        <div className="metric">
          <b>{total}</b>
          <span>Total Steps</span>
        </div>
        <div className="metric" data-tone="ok">
          <b>{completed}</b>
          <span>Completed</span>
        </div>
        <div className="metric" data-tone="active">
          <b>{running}</b>
          <span>Running</span>
        </div>
        <div className="metric" data-tone="danger">
          <b>{failed}</b>
          <span>Failed</span>
        </div>
      </div>
    </section>
  );
}
