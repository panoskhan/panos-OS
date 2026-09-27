import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { EventTimeline } from "./components/EventTimeline";
import { ExecutionGraph } from "./components/ExecutionGraph";
import { DEFAULT_GOAL, GoalInput } from "./components/GoalInput";
import { OrbitalCanvas } from "./components/OrbitalCanvas";
import { QaResultPanel } from "./components/QaResultPanel";
import { RightSidebar } from "./components/RightSidebar";
import { Sidebar } from "./components/Sidebar";
import { SystemReport } from "./components/SystemReport";
import { TopBar } from "./components/TopBar";
import { useProjectInfo } from "./hooks/useProjectInfo";
import { useTask } from "./hooks/useTask";
import { useTaskHistory } from "./hooks/useTaskHistory";
import { api } from "./lib/api";
import { useApiHealth } from "./lib/apiState";
import "./styles.css";

function App() {
  const apiState = useApiHealth();
  const { report, error, pending, polling, createTask, approve, reject, selectTask } = useTask();
  const history = useTaskHistory(report);
  const { info: projectInfo, error: projectError } = useProjectInfo();
  const [goal, setGoal] = useState(DEFAULT_GOAL);

  const refreshKey = report
    ? `${report.task.status}:${report.execution.map((entry) => entry.status).join(",")}`
    : "";

  function focusGoalInput() {
    document.getElementById("goal-input")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("goal")?.focus();
  }

  function handleRecommend(nextGoal: string) {
    setGoal(nextGoal);
    focusGoalInput();
  }

  return (
    <div className="app">
      <Sidebar apiState={apiState} report={report} />

      <main className="main" id="khan-main">
        <TopBar apiState={apiState} polling={polling} />
        <OrbitalCanvas />

        <GoalInput goal={goal} onGoalChange={setGoal} onSubmit={createTask} busy={pending === "create"} />

        {error && (
          <div className="error-banner" role="alert">
            <strong>Request failed:</strong> {error}
            {apiState === "offline" && <> — is the API running at <code>{api.baseUrl}</code>?</>}
          </div>
        )}

        <div className="content-grid">
          <ExecutionGraph report={report} />
          <EventTimeline taskId={report?.task.id} refreshKey={refreshKey} />
        </div>

        <SystemReport report={report} />

        <ApprovalPanel key={report?.task.id} report={report} pending={pending} onApprove={approve} onReject={reject} />

        <QaResultPanel report={report} />
      </main>

      <RightSidebar
        history={history}
        activeTaskId={report?.task.id}
        onSelectTask={selectTask}
        selecting={pending === "select"}
        projectInfo={projectInfo}
        projectError={projectError}
        report={report}
        onRecommend={handleRecommend}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
