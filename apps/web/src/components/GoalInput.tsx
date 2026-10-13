import { useState, type FormEvent } from "react";

const PRESETS = [
  { label: "Analysis", goal: "Analyze this project and identify the next engineering tasks." },
  { label: "Testing", goal: "Test the orchestration pipeline." },
  { label: "Implementation", goal: "Implement a safer approval flow." },
  { label: "GitHub approval", goal: "Implement the fix and push the changes to GitHub." }
];

const DEMOS = [
  { label: "Analyze a project", goal: PRESETS[0].goal, description: "Watch planning, analysis, and verification complete." },
  { label: "Explore the test workflow", goal: PRESETS[1].goal, description: "See how simulated agent steps reach a QA verdict." },
  { label: "Show an approval workflow", goal: PRESETS[3].goal, description: "See a protected action pause for owner approval." }
];

interface GoalInputProps {
  onSubmit: (goal: string) => Promise<void>;
  busy: boolean;
}

export function GoalInput({ onSubmit, busy }: GoalInputProps) {
  const [goal, setGoal] = useState(PRESETS[0].goal);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (trimmed && !busy) await onSubmit(trimmed);
  }

  return (
    <section className="panel">
      {import.meta.env.VITE_PUBLIC_DEMO === "true" && <div className="guided-demos">
        <h2>Try a guided demo</h2>
        <p>Choose a walkthrough to start. Each visitor has a separate, temporary session.</p>
        <div className="chips">{DEMOS.map(demo => <button key={demo.label} className="chip" type="button" disabled={busy} onClick={() => { setGoal(demo.goal); void onSubmit(demo.goal); }}>
          <strong>{demo.label}</strong><span>{demo.description}</span>
        </button>)}</div>
      </div>}
      <form className="goal-row" onSubmit={submit}>
        <label className="sr-only" htmlFor="goal">Goal</label>
        <input
          id="goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Describe what KHAN should do…"
          autoComplete="off"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !goal.trim()}>
          {busy ? "Running…" : "Run KHAN"}
        </button>
      </form>
      <div className="chips">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className="chip"
            aria-pressed={goal === preset.goal}
            onClick={() => setGoal(preset.goal)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}
