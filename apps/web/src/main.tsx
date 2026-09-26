import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { EventTimeline } from "./components/EventTimeline";
import { ExecutionGraph } from "./components/ExecutionGraph";
import { GoalInput } from "./components/GoalInput";
import { SystemReport } from "./components/SystemReport";
import { useTask } from "./hooks/useTask";
import { api } from "./lib/api";
import "./styles.css";

type ApiState = "checking" | "online" | "offline";

function useApiHealth(): ApiState {
  const [state, setState] = useState<ApiState>("checking");
  useEffect(() => {
    let active = true;
    api.health().then(
      () => active && setState("online"),
      () => active && setState("offline")
    );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

function App() {
  const apiState = useApiHealth();
  const { report, error, pending, polling, createTask, approve, reject } = useTask();
  const refreshKey = report
    ? `${report.task.status}:${report.execution.map((entry) => entry.status).join(",")}`
    : "";

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <div className="orb" aria-hidden="true" />
          <div>
            <h1>KHAN OS</h1>
            <small>AI ORCHESTRATION CORE</small>
          </div>
        </div>
        <div className="api-status" data-state={apiState} title={api.baseUrl}>
          <i aria-hidden="true" />
          {apiState === "online" ? "API ONLINE" : apiState === "offline" ? "API OFFLINE" : "CONNECTING"}
          {polling && <span className="polling">· LIVE</span>}
        </div>
      </header>

      <section className="hero">
        <h2>Understand. Plan. Act. Verify.</h2>
        <p>
          Goals go to the real KHAN OS API. The orchestrator plans a task graph, runs it through the permission-gated
          agent runtime and independent QA, and stops for your decision before any protected step executes.
        </p>
      </section>

      <GoalInput onSubmit={createTask} busy={pending === "create"} />

      {error && (
        <div className="error-banner" role="alert">
          <strong>Request failed:</strong> {error}
          {apiState === "offline" && <> — is the API running at <code>{api.baseUrl}</code>?</>}
        </div>
      )}

      <div className="grid">
        <div className="stack">
          <ExecutionGraph report={report} />
          <ApprovalPanel
            key={report?.task.id}
            report={report}
            pending={pending}
            onApprove={approve}
            onReject={reject}
          />
        </div>
        <SystemReport report={report} />
      </div>

      <EventTimeline taskId={report?.task.id} refreshKey={refreshKey} />

      <footer className="footer">KHAN OS · local development interface · {api.baseUrl}</footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
