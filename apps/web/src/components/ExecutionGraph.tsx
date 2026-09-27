import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { StatusBadge } from "./StatusBadge";

export function ExecutionGraph({ report }: { report: TaskResponse | null }) {
  const executionByStep = new Map(report?.execution.map((entry) => [entry.stepId, entry]));

  return (
    <section className="panel" id="execution-graph">
      <header className="panel-head">
        <h2>Execution graph</h2>
        {report ? <StatusBadge status={report.task.status} /> : <span className="muted">READY</span>}
      </header>

      {!report ? (
        <p className="empty">Submit a goal to see the planned steps and their real execution status.</p>
      ) : report.plan.length === 0 ? (
        <p className="empty">No plan was produced.</p>
      ) : (
        <ol className="steps">
          {report.plan.map((step, index) => {
            const entry = executionByStep.get(step.id);
            return (
              <li key={step.id} className="step" data-status={entry?.status ?? "pending"}>
                <span className="step-num">{index + 1}</span>
                <div className="step-body">
                  <strong>{step.title}</strong>
                  <small>
                    {step.agent} · {step.permissions.join(", ")}
                    {step.dependsOn.length > 0 && <> · after {step.dependsOn.join(", ")}</>}
                  </small>
                  {entry?.output && <p className="step-output">{entry.output.summary}</p>}
                </div>
                <StatusBadge status={entry?.status ?? "pending"} />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
