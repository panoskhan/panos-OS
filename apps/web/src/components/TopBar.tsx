import type { ApiState } from "../lib/apiState";

interface TopBarProps {
  apiState: ApiState;
  polling: boolean;
}

export function TopBar({ apiState, polling }: TopBarProps) {
  return (
    <div className="topbar">
      <div className="topbar-phases">
        <span>UNDERSTAND</span>
        <span>PLAN</span>
        <span>ACT</span>
        <span>VERIFY</span>
      </div>
      <div className="core-badge" data-state={apiState}>
        <i aria-hidden="true" />
        {apiState === "online" ? "CORE ONLINE" : apiState === "offline" ? "CORE OFFLINE" : "CONNECTING"}
        {polling && <span className="live">· LIVE</span>}
      </div>
    </div>
  );
}
