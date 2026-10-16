import { useState } from "react";
import { SWARM_DEFAULT_SIZE, SWARM_MAX_SIZE, SWARM_MIN_SIZE, type Contender, type Swarm } from "../../../../packages/contracts/src/swarm";
import type { SwarmsApi } from "../hooks/useSwarms";

function scoreBar(score: number): string {
  const filled = Math.round(score / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function statusTone(status: Swarm["status"]): string {
  if (status === "judged") return "active";
  if (status === "no_winner") return "warn";
  return "ok";
}

function ContenderRow({ c, winner }: { c: Contender; winner?: string }) {
  const isWinner = winner === c.strategy;
  return (
    <li className="contender-row" data-winner={isWinner || undefined}>
      <div className="contender-head">
        <span className="contender-strategy">{c.strategy}</span>
        {isWinner && <span className="badge" data-tone="active">winner</span>}
        <span className="badge" data-tone={c.status === "completed" ? "active" : c.status === "failed" ? "danger" : "ok"}>
          {c.status}
        </span>
      </div>
      <div className="contender-stats">
        <span className="contender-score" title={`Score: ${c.score}/100`}>
          <code>{scoreBar(c.score)}</code>
          <small>{c.score}</small>
        </span>
        <span className="contender-steps">
          {c.completedSteps}/{c.totalSteps} steps
        </span>
        {c.qaPassed && <span className="badge" data-tone="active">QA ✓</span>}
      </div>
    </li>
  );
}

function SwarmCard({ swarm }: { swarm: Swarm }) {
  const [open, setOpen] = useState(false);
  const running = swarm.contenders.filter((c) => ["received", "understanding", "planning", "executing", "verifying"].includes(c.status)).length;

  return (
    <li className="swarm-card" data-status={swarm.status}>
      <button
        type="button"
        className="swarm-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="swarm-problem">{swarm.problem}</span>
        <span className="badge" data-tone={statusTone(swarm.status)}>{swarm.status}</span>
        {swarm.status === "running" && (
          <span className="swarm-running">{running}/{swarm.contenders.length} running</span>
        )}
        {swarm.winner && <span className="swarm-winner">🏆 {swarm.winner}</span>}
        <span className="swarm-toggle" aria-hidden="true">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="swarm-body">
          {swarm.verdict && <p className="swarm-verdict">{swarm.verdict}</p>}
          <ul className="contender-list">
            {swarm.contenders.map((c) => (
              <ContenderRow key={c.strategy} c={c} winner={swarm.winner} />
            ))}
          </ul>
          <p className="swarm-meta">
            <code>{swarm.id.slice(0, 8)}</code>
            {" · "}
            {new Date(swarm.createdAt).toLocaleTimeString()}
          </p>
        </div>
      )}
    </li>
  );
}

interface SwarmPanelProps {
  swarms: SwarmsApi;
}

const SIZES = [
  { value: 2, label: "2 contenders (quick)" },
  { value: 4, label: "4 contenders (default)" },
  { value: 6, label: "6 contenders (thorough)" },
  { value: 8, label: "8 contenders (max)" }
];

export function SwarmPanel({ swarms }: SwarmPanelProps) {
  const [problem, setProblem] = useState("");
  const [size, setSize] = useState(SWARM_DEFAULT_SIZE);

  const running = swarms.swarms.filter((s) => s.status === "running").length;
  const judged = swarms.swarms.filter((s) => s.status === "judged").length;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = problem.trim();
    if (!trimmed || swarms.launching) return;
    await swarms.launch(trimmed, size);
    setProblem("");
  }

  return (
    <section className="panel" aria-labelledby="swarms-title">
      <div className="panel-head">
        <h2 id="swarms-title">Swarm Wars</h2>
        <span className="ghost-summary">
          {running} running · {judged} judged
        </span>
      </div>

      <p className="note">
        Several agents attack the same problem in parallel — each gated, each audited. The arena scores them all and
        declares a winner. A problem that needs human approval parks every contender at the gate, so nothing sneaks past
        the safety check.
      </p>

      {swarms.error && (
        <div className="error-banner" role="alert">
          <strong>Swarm request failed:</strong> {swarms.error}
        </div>
      )}

      {swarms.swarms.length ? (
        <ul className="swarm-list">
          {swarms.swarms.map((s) => (
            <SwarmCard key={s.id} swarm={s} />
          ))}
        </ul>
      ) : (
        <p className="empty">
          {swarms.loaded
            ? "No swarms yet. Give the arena a problem below."
            : "Loading arena…"}
        </p>
      )}

      <form className="ghost-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="swarm-problem">Problem</label>
        <input
          id="swarm-problem"
          value={problem}
          placeholder="Problem to solve, e.g. audit all tasks completed today for anomalies"
          onChange={(e) => setProblem(e.target.value)}
        />
        <label className="sr-only" htmlFor="swarm-size">Contenders</label>
        <select
          id="swarm-size"
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        >
          {SIZES.filter((s) => s.value >= SWARM_MIN_SIZE && s.value <= SWARM_MAX_SIZE).map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!problem.trim() || swarms.launching}
        >
          {swarms.launching ? "Launching…" : "Launch Swarm"}
        </button>
      </form>
      <p className="note">
        Min {SWARM_MIN_SIZE} / max {SWARM_MAX_SIZE} contenders. Each runs as an independent gated task.
      </p>
    </section>
  );
}
