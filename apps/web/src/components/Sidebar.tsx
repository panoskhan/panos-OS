import type { ComponentId } from "../../../../packages/contracts/src/api";
import type { SystemStatus } from "../hooks/useSystemStatus";
import type { AvatarState } from "../lib/derive";

interface SidebarProps {
  status: SystemStatus;
  avatar: AvatarState;
  onHome: () => void;
  onNewTask: () => void;
  onHistory: () => void;
  onSettings: () => void;
}

interface NavItem {
  label: string;
  glyph: string;
  action?: "home" | "new" | "history" | "settings";
}

const NAV: NavItem[] = [
  { label: "Home", glyph: "◉", action: "home" },
  { label: "New Task", glyph: "+", action: "new" },
  { label: "Projects", glyph: "▤" },
  { label: "Agents", glyph: "◈" },
  { label: "Model Router", glyph: "⇄" },
  { label: "Permissions", glyph: "⛨" },
  { label: "History", glyph: "◷", action: "history" },
  { label: "Settings", glyph: "⚙", action: "settings" }
];

// Shown before the first answer and while the API is unreachable. The states come from GET /v1/status once it answers.
const COMPONENT_NAMES: Array<[ComponentId, string]> = [
  ["orchestrator", "Orchestrator"],
  ["model-router", "Model Router"],
  ["agents", "Agents"],
  ["permissions", "Permissions"],
  ["qa", "Independent QA"],
  ["audit", "Audit Log"],
  ["rate-limiter", "Rate Limiter"]
];

const AVATAR_TONE: Record<AvatarState, string> = {
  Ready: "ok",
  Thinking: "active",
  "Waiting Approval": "warn"
};

interface Row {
  id: ComponentId;
  name: string;
  /** Drives the dot colour. */
  dot: "online" | "offline" | "idle" | "checking";
  label: string;
  detail: string;
}

function rowsFor({ state, report }: SystemStatus): Row[] {
  if (report) {
    return report.components.map((component) => {
      switch (component.state) {
        case "up":
          return { id: component.id, name: component.name, dot: "online", label: "Online", detail: component.detail };
        case "down":
          return { id: component.id, name: component.name, dot: "offline", label: "Down", detail: component.detail };
        case "not_configured":
          return { id: component.id, name: component.name, dot: "idle", label: "Not wired", detail: component.detail };
      }
    });
  }
  return COMPONENT_NAMES.map(([id, name]) =>
    state === "offline"
      ? {
          id,
          name,
          dot: id === "orchestrator" ? "offline" : "idle",
          label: id === "orchestrator" ? "Offline" : "Unknown",
          detail: id === "orchestrator" ? "The API is not answering." : "Unknown while the API is not answering."
        }
      : { id, name, dot: "checking", label: "Checking", detail: "Waiting for the first status report." }
  );
}

export function Sidebar({ status, avatar, onHome, onNewTask, onHistory, onSettings }: SidebarProps) {
  const handlers = { home: onHome, new: onNewTask, history: onHistory, settings: onSettings };
  const rows = rowsFor(status);
  const online = status.report?.components.filter((component) => component.state === "up").length ?? 0;
  const anyDown = status.report?.components.some((component) => component.state === "down") ?? false;
  const badgeTone = status.state !== "online" || online === 0 ? "danger" : anyDown ? "warn" : "ok";

  return (
    <aside className="sidebar sidebar-left" aria-label="KHAN OS navigation">
      <div className="brand">
        <div className="orb" aria-hidden="true" />
        <div>
          <h1>KHAN OS</h1>
          <small>AI Orchestration Core</small>
        </div>
      </div>

      <nav aria-label="Primary">
        <ul className="nav">
          {NAV.map((item) => (
            <li key={item.label}>
              <button
                type="button"
                className="nav-item"
                aria-current={item.action === "home" ? "page" : undefined}
                disabled={!item.action}
                title={item.action ? undefined : "Coming soon"}
                onClick={item.action ? handlers[item.action] : undefined}
              >
                <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
                {item.label}
                {!item.action && <span className="nav-soon">Soon</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="system-status" aria-labelledby="system-status-title">
        <h2 id="system-status-title" className="rail-title">System Status</h2>
        <ul>
          {rows.map((row) => (
            <li key={row.id} data-state={row.dot} title={row.detail}>
              <i aria-hidden="true" />
              <span>{row.name}</span>
              <small>{row.label}</small>
              <span className="sr-only">. {row.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="sidebar-foot">
        <div className="version">
          <span>KHAN OS v{__APP_VERSION__}</span>
          <span className="badge" data-tone={badgeTone}>{online} ONLINE</span>
        </div>
        <div className="avatar" data-tone={AVATAR_TONE[avatar]}>
          <div className="orb orb-small" aria-hidden="true" />
          <div>
            <strong>KHAN</strong>
            <small role="status">
              <i aria-hidden="true" />
              {avatar}
            </small>
          </div>
        </div>
      </footer>
    </aside>
  );
}
