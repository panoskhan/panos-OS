import { useState } from "react";
import { MIN_INTERVAL_MS, type Ghost, type GhostSchedule } from "../../../../packages/contracts/src/ghost";
import type { GhostsApi } from "../hooks/useGhosts";

/** Intervals offered for the "interval" schedule type. */
const INTERVALS = [
  { ms: 5000, label: "5s" },
  { ms: 15000, label: "15s" },
  { ms: 60000, label: "1m" },
  { ms: 300000, label: "5m" },
  { ms: 3600000, label: "1h" },
];

type ScheduleMode = "interval" | "cron";

function cadence(ghost: Ghost): string {
  const s = ghost.schedule;
  if (s.type === "interval") {
    const ms = s.ms;
    if (ms < 60000) return `every ${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `every ${Math.round(ms / 60000)}m`;
    return `every ${Math.round(ms / 3600000)}h`;
  }
  // cron
  return `cron: ${s.expression}${s.tz ? ` (${s.tz})` : ""}`;
}

function sinceLabel(iso: string | undefined): string {
  if (!iso) return "not yet";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function nextLabel(iso: string | undefined): string {
  if (!iso) return "—";
  const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return `in ${Math.round(seconds / 3600)}h`;
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
        {ghost.schedule.type === "cron" && (
          <span className="badge" data-tone="ok">cron</span>
        )}
      </div>

      <dl className="ghost-stats">
        <div>
          <dt>Fired</dt>
          <dd className="ghost-count">{ghost.fireCount}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd title={ghost.schedule.type === "cron" ? ghost.schedule.expression : undefined}>
            {cadence(ghost)}
          </dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>{sinceLabel(ghost.lastFiredAt)}</dd>
        </div>
        {ghost.nextFireAt && (
          <div>
            <dt>Next</dt>
            <dd>{nextLabel(ghost.nextFireAt)}</dd>
          </div>
        )}
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
  const [mode, setMode] = useState<ScheduleMode>("interval");
  const [ms, setMs] = useState(INTERVALS[0].ms);
  const [cronExpr, setCronExpr] = useState("0 9 * * *");
  const [cronTz, setCronTz] = useState("");

  const active = ghosts.ghosts.filter((g) => g.status === "active").length;
  const firings = ghosts.ghosts.reduce((total, g) => total + g.fireCount, 0);
  const registering = ghosts.pendingAction === "register";

  function buildSchedule(): GhostSchedule {
    if (mode === "cron") {
      return { type: "cron", expression: cronExpr.trim(), ...(cronTz.trim() ? { tz: cronTz.trim() } : {}) };
    }
    return { type: "interval", ms };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (!trimmed || registering) return;
    await ghosts.register(trimmed, buildSchedule());
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

        {/* Schedule type selector */}
        <fieldset className="ghost-schedule-type" style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: "0.5rem" }}>
          <legend className="sr-only">Schedule type</legend>
          <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", cursor: "pointer" }}>
            <input type="radio" name="ghost-mode" value="interval" checked={mode === "interval"} onChange={() => setMode("interval")} />
            Interval
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", cursor: "pointer" }}>
            <input type="radio" name="ghost-mode" value="cron" checked={mode === "cron"} onChange={() => setMode("cron")} />
            Cron
          </label>
        </fieldset>

        {mode === "interval" ? (
          <>
            <label className="sr-only" htmlFor="ghost-interval">Interval</label>
            <select id="ghost-interval" value={ms} onChange={(event) => setMs(Number(event.target.value))}>
              {INTERVALS.map((option) => (
                <option key={option.ms} value={option.ms}>
                  every {option.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="ghost-cron">Cron expression</label>
            <input
              id="ghost-cron"
              value={cronExpr}
              placeholder='e.g. "0 9 * * *" (daily at 09:00)'
              onChange={(e) => setCronExpr(e.target.value)}
              style={{ fontFamily: "monospace" }}
            />
            <label className="sr-only" htmlFor="ghost-tz">Timezone (optional)</label>
            <input
              id="ghost-tz"
              value={cronTz}
              placeholder="Timezone, e.g. Europe/Athens (default: UTC)"
              onChange={(e) => setCronTz(e.target.value)}
            />
          </>
        )}

        <button type="submit" className="btn btn-primary" disabled={!goal.trim() || registering}>
          {registering ? "Registering…" : "Register"}
        </button>
      </form>
      <p className="note">
        Interval: minimum {Math.round(MIN_INTERVAL_MS / 1000)}s. Cron: 5-field expression, minute to day-of-week.
      </p>
    </section>
  );
}
