import { useState } from "react";
import type { TaskResponse } from "../../../../packages/contracts/src/api";
import type { TaskAction } from "../hooks/useTask";

interface ApprovalPanelProps {
  report: TaskResponse | null;
  pending: TaskAction | null;
  onApprove: () => Promise<void>;
  onReject: (reason?: string) => Promise<void>;
}

export function ApprovalPanel({ report, pending, onApprove, onReject }: ApprovalPanelProps) {
  const [reason, setReason] = useState("");

  if (report?.task.status !== "waiting_approval") return null;

  const gatedEntry = report.execution.find((entry) => entry.status === "waiting_approval");
  const gatedStep = report.plan.find((step) => step.id === gatedEntry?.stepId);
  const busy = pending !== null;

  return (
    <section className="panel approval" aria-live="polite">
      <header className="panel-head">
        <h2>Approval required</h2>
        <span className="muted">Execution stopped</span>
      </header>
      <p>
        Step <strong>{gatedStep?.title ?? gatedEntry?.stepId ?? "unknown"}</strong> needs a decision before the
        agent runs. Nothing gated has executed yet.
      </p>
      {gatedStep && (
        <ul className="permissions">
          {gatedStep.permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      )}
      <label className="sr-only" htmlFor="reject-reason">Reason for rejection</label>
      <input
        id="reject-reason"
        className="reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason (optional, sent with Reject)"
      />
      <div className="actions">
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => onApprove()}>
          {pending === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          className="btn btn-danger"
          type="button"
          disabled={busy}
          onClick={() => onReject(reason.trim() || undefined)}
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </section>
  );
}
