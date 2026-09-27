import type { TaskResponse } from "../../../../packages/contracts/src/api";
import { isTerminal } from "../hooks/useTask";
import type { ApiState } from "../lib/apiState";

type Tone = "ok" | "warn" | "danger";

interface SidebarProps {
  apiState: ApiState;
  report: TaskResponse | null;
}

interface NavEntry {
  label: string;
  targetId?: string;
}

const NAV_ITEMS: NavEntry[] = [
  { label: "Home", targetId: "khan-main" },
  { label: "New Task", targetId: "goal-input" },
  { label: "Projects" },
  { label: "Agents", targetId: "execution-graph" },
  { label: "Model Router" },
  { label: "Permissions", targetId: "execution-graph" },
  { label: "History", targetId: "activity-log" },
  { label: "Settings" }
];

function baseTone(apiState: ApiState): Tone {
  return apiState === "online" ? "ok" : apiState === "checking" ? "warn" : "danger";
}

function agentsTone(apiState: ApiState, report: TaskResponse | null): Tone {
  if (report?.execution.some((entry) => entry.status === "failed")) return "danger";
  return baseTone(apiState);
}

function permissionsTone(apiState: ApiState, report: TaskResponse | null): Tone {
  if (report?.task.status === "waiting_approval") return "warn";
  return baseTone(apiState);
}

function qaTone(apiState: ApiState, report: TaskResponse | null): Tone {
  if (!report) return baseTone(apiState);
  if (!isTerminal(report.task.status)) return "warn";
  return report.verification.passed ? "ok" : "danger";
}

function avatarState(report: TaskResponse | null): "ready" | "thinking" | "waiting_approval" {
  if (!report || isTerminal(report.task.status)) return "ready";
  if (report.task.status === "waiting_approval") return "waiting_approval";
  return "thinking";
}

const AVATAR_LABEL: Record<ReturnType<typeof avatarState>, string> = {
  ready: "Ready",
  thinking: "Thinking",
  waiting_approval: "Waiting Approval"
};

function scrollTo(targetId?: string) {
  if (!targetId) return;
  document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (targetId === "goal-input") document.getElementById("goal")?.focus();
}

export function Sidebar({ apiState, report }: SidebarProps) {
  const status = [
    { label: "Orchestrator", tone: baseTone(apiState) },
    { label: "Model Router", tone: baseTone(apiState) },
    { label: "Agents", tone: agentsTone(apiState, report) },
    { label: "Permissions", tone: permissionsTone(apiState, report) },
    { label: "Independent QA", tone: qaTone(apiState, report) }
  ];
  const state = avatarState(report);

  return (
    <aside className="sidebar-left">
      <div className="brand">
        <div className="orb" aria-hidden="true" />
        <div>
          <h1>KHAN OS</h1>
          <small>AI ORCHESTRATION CORE</small>
        </div>
      </div>

      <nav className="sidebar-section" aria-label="Primary">
        <ul className="nav-list">
          {NAV_ITEMS.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                className="nav-item"
                aria-current={item.label === "Home" ? "page" : undefined}
                disabled={!item.targetId}
                title={item.targetId ? undefined : "Not wired up yet"}
                onClick={() => scrollTo(item.targetId)}
              >
                <span className="nav-dot" aria-hidden="true" />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="sidebar-section">
        <p className="sidebar-section-title">System Status</p>
        <ul className="status-list">
          {status.map((entry) => (
            <li key={entry.label} className="status-item">
              <span className="status-dot" data-tone={entry.tone} aria-hidden="true" />
              {entry.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="sidebar-footer">
        <div className="version-row">
          <span>KHAN OS v0.1.0</span>
          <span className="online-badge" data-online={apiState === "online"}>
            <i aria-hidden="true" />
            {apiState === "online" ? "1 ONLINE" : "0 ONLINE"}
          </span>
        </div>
        <div className="avatar-card">
          <div className="avatar-ring" data-state={state} aria-hidden="true" />
          <div>
            <div className="avatar-name">KHAN</div>
            <div className="avatar-state">{AVATAR_LABEL[state]}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
