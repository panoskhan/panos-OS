import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { stepCounts } from "../lib/derive";
import { StatusBadge } from "./StatusBadge";

export function SystemReport({ report }: { report: TaskResponse | null }) {
  const counts = stepCounts(report);
  const metrics = [
    { label: "Total Steps", value: counts.total, tone: "" },
    { label: "Completed", value: counts.completed, tone: "ok" },
    { label: "Running", value: counts.running, tone: "active" },
    { label: "Failed", value: counts.failed, tone: "danger" }
  ];

  return (
    <section className="panel" aria-labelledby="report-title">
      <header className="panel-head">
        <h2 id="report-title">System report</h2>
        {report ? <StatusBadge status={report.task.status} /> : <span className="muted">IDLE</span>}
      </header>
      <div className="metrics">
        {metrics.map((metric) => (
          <div key={metric.label} className="metric" data-tone={metric.tone}>
            <b>{metric.value}</b>
            <span>{metric.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
