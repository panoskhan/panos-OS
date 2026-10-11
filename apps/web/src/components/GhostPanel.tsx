import { useState } from "react";
import { MIN_INTERVAL_MS, type Ghost } from "../../../../packages/contracts/src/ghost";
import type { GhostsApi } from "../hooks/useGhosts";

/** Intervals offered in the form. The registry refuses anything under MIN_INTERVAL_MS. */
const INTERVALS = [
  { ms: 5000, label: "5s" },
  { ms: 15000, label: "15s" },
  { ms: 60000, label: "1m" },
  { ms: 300000, label: "5m" }
];

function cadence(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function sinceLabel(iso: string | undefined): string {
  if (!iso) return "not yet";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function GhostRow({ ghost, ghosts }: { ghost: Ghost; ghosts: GhostsApi }) {
  const paused = ghost.status === "paused";
  const busy = ghosts.pendingId === ghost.id;

  return (
    <li className="ghost-row" data-status={ghost.status}>
      <div className="ghost-main">
        <span className="ghost-goal">{ghost.goal}</span>
        <span className="badge" data-tone={paused ? "warn" : "active"}>
          {ghost.status}
        </span>
      </div>

      <dl className="ghost-stats">
        <div>
          <dt>Fired</dt>
          <dd className="ghost-count">{ghost.fireCount}</dd>
        </div>
        <div>
          <dt>Every</dt>
          <dd>{cadence(ghost.schedule.ms)}</dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>{sinceLabel(ghost.lastFiredAt)}</dd>
        </div>
      </dl>

      <div className="ghost-actions">
        <button
          type="button"
          className="chip"
          disabled={busy}
          onClick={() => void (paused ? ghosts.resume(ghost.id) : ghosts.pause(ghost.id))}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className="chip" disabled={busy} onClick={() => void ghosts.remove(ghost.id)}>
          Retire
        </button>
        <code className="ghost-id" title={ghost.id}>
          {ghost.id.slice(0, 8)}
        </code>
      </div>
    </li>
  );
}

export function GhostPanel({ ghosts }: { ghosts: GhostsApi }) {
  const [goal, setGoal] = useState("");
  const [ms, setMs] = useState(INTERVALS[0].ms);

  const active = ghosts.ghosts.filter((g) => g.status === "active").length;
  const firings = ghosts.ghosts.reduce((total, g) => total + g.fireCount, 0);
  const registering = ghosts.pendingAction === "register";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || registering) return;
    await ghosts.register(trimmed, { type: "interval", ms });
    setGoal("");
  }

  return (
    <section className="panel" aria-labelledby="ghosts-title">
      <div className="panel-head">
        <h2 id="ghosts-title">Ghost Mode</h2>
        <span className="ghost-summary">
          {active} active · {firings} firings
        </span>
      </div>

      <p className="note">
        Standing goals that fire on a schedule with no prompt. Every task they start goes through the same approval
        gate, and the roster survives a restart.
      </p>

      {ghosts.error && (
        <div className="error-banner" role="alert">
          <strong>Ghost request failed:</strong> {ghosts.error}
        </div>
      )}

      {ghosts.ghosts.length ? (
        <ul className="ghost-list">
          {ghosts.ghosts.map((ghost) => (
            <GhostRow key={ghost.id} ghost={ghost} ghosts={ghosts} />
          ))}
        </ul>
      ) : (
        <p className="empty">
          {ghosts.loaded ? "No ghosts registered. Give one a goal below and it starts firing." : "Reading the registry…"}
        </p>
      )}

      <form className="ghost-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="ghost-goal">
          Standing goal
        </label>
        <input
          id="ghost-goal"
          value={goal}
          placeholder="Standing goal, e.g. sweep the audit log for refusals"
          onChange={(event) => setGoal(event.target.value)}
        />
        <label className="sr-only" htmlFor="ghost-interval">
          Interval
        </label>
        <select id="ghost-interval" value={ms} onChange={(event) => setMs(Number(event.target.value))}>
          {INTERVALS.map((option) => (
            <option key={option.ms} value={option.ms}>
              every {option.label}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary" disabled={!goal.trim() || registering}>
          {registering ? "Registering…" : "Register"}
        </button>
      </form>
      <p className="note">Minimum interval is {Math.round(MIN_INTERVAL_MS / 1000)}s; the registry refuses anything shorter.</p>
    </section>
  );
}
