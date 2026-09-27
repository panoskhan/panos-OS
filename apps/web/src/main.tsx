import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { EventTimeline } from "./components/EventTimeline";
import { ExecutionGraph } from "./components/ExecutionGraph";
import { GoalInput } from "./components/GoalInput";
import { OrbitalCanvas } from "./components/OrbitalCanvas";
import { QaResult } from "./components/QaResult";
import { RightRail } from "./components/RightRail";
import { Sidebar } from "./components/Sidebar";
import { SystemReport } from "./components/SystemReport";
import { useSystemStatus } from "./hooks/useSystemStatus";
import { isTerminal, useTask } from "./hooks/useTask";
import { useTaskHistory } from "./hooks/useTaskHistory";
import { api } from "./lib/api";
import { activeAgents, avatarState } from "./lib/derive";
import "./styles.css";

function focusGoal() {
  const input = document.getElementById("goal");
  input?.scrollIntoView({ behavior: "smooth", block: "center" });
  input?.focus();
}

function App() {
  const { report, events, connection, error, pending, createTask, load, approve, reject } = useTask();
  // Re-check the system the moment the live task connection has trouble, not only on the 5 s timer.
  const status = useSystemStatus(`${connection}|${error ?? ""}`);
  const apiState = status.state;
  const degraded = status.report?.status === "degraded";
  const tasks = useTaskHistory(report);

  const avatar = avatarState(report, pending);
  const active = useMemo(() => activeAgents(report, pending), [report, pending]);
  const finished = report !== null && isTerminal(report.task.status);

  const coreLabel =
    apiState === "online" ? (degraded ? "CORE DEGRADED" : "CORE ONLINE") : apiState === "offline" ? "CORE OFFLINE" : "CONNECTING";

  return (
    <div className="app">
      <Sidebar
        status={status}
        avatar={avatar}
        onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        onNewTask={focusGoal}
        onHistory={() => document.getElementById("recent-tasks")?.focus()}
      />

      <main className="main">
        <header className="topbar">
          <p className="tagline">Understand · Plan · Act · Verify</p>
          <div className="core-badge" data-state={degraded ? "degraded" : apiState} title={api.baseUrl}>
            <i aria-hidden="true" />
            {coreLabel}
            {connection === "live" && <span className="live">· LIVE</span>}
            {connection === "polling" && <span className="live poll">· POLLING</span>}
          </div>
        </header>

        <section className="panel panel-flush" aria-label="Agent orbit">
          <OrbitalCanvas active={active} busy={avatar === "Thinking"} />
        </section>

        <GoalInput onSubmit={createTask} busy={pending === "create"} />

        {error && (
          <div className="error-banner" role="alert">
            <strong>Request failed:</strong> {error}
            {apiState === "offline" && <> — is the API running at <code>{api.baseUrl}</code>?</>}
          </div>
        )}

        {/* A blocking decision goes first: it must be visible without scrolling. */}
        <ApprovalPanel
          key={report?.task.id}
          report={report}
          pending={pending}
          onApprove={approve}
          onReject={reject}
        />

        <div className="duo">
          <ExecutionGraph report={report} />
          <EventTimeline taskId={report?.task.id} events={events} />
        </div>

        <SystemReport report={report} />

        {finished && <QaResult report={report} />}
      </main>

      <RightRail report={report} tasks={tasks} onSelect={load} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
