import type { ApiState } from "../hooks/useApiHealth";
import type { AvatarState } from "../lib/derive";

interface SidebarProps {
  apiState: ApiState;
  avatar: AvatarState;
  onHome: () => void;
  onNewTask: () => void;
  onHistory: () => void;
}

interface NavItem {
  label: string;
  glyph: string;
  action?: "home" | "new" | "history";
}

const NAV: NavItem[] = [
  { label: "Home", glyph: "◉", action: "home" },
  { label: "New Task", glyph: "+", action: "new" },
  { label: "Projects", glyph: "▤" },
  { label: "Agents", glyph: "◈" },
  { label: "Model Router", glyph: "⇄" },
  { label: "Permissions", glyph: "⛨" },
  { label: "History", glyph: "◷", action: "history" },
  { label: "Settings", glyph: "⚙" }
];

// Only the orchestrator has a real health probe (GET /health). The rest are shown honestly as unmonitored.
const SERVICES = ["Orchestrator", "Model Router", "Agents", "Permissions", "Independent QA"];

const AVATAR_TONE: Record<AvatarState, string> = {
  Ready: "ok",
  Thinking: "active",
  "Waiting Approval": "warn"
};

export function Sidebar({ apiState, avatar, onHome, onNewTask, onHistory }: SidebarProps) {
  const handlers = { home: onHome, new: onNewTask, history: onHistory };
  const online = apiState === "online" ? 1 : 0;
  const orchestratorState = apiState === "online" ? "Online" : apiState === "offline" ? "Offline" : "Checking";

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
          {SERVICES.map((name) => {
            const probed = name === "Orchestrator";
            const state = probed ? apiState : "unmonitored";
            return (
              <li key={name} data-state={state}>
                <i aria-hidden="true" />
                <span>{name}</span>
                <small>{probed ? orchestratorState : "No probe"}</small>
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="sidebar-foot">
        <div className="version">
          <span>KHAN OS v{__APP_VERSION__}</span>
          <span className="badge" data-tone={online ? "ok" : "danger"}>{online} ONLINE</span>
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
