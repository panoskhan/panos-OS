import type { FormEvent } from "react";

const PRESETS = [
  { label: "Analysis", goal: "Analyze this project and identify the next engineering tasks." },
  { label: "Testing", goal: "Test the orchestration pipeline." },
  { label: "Implementation", goal: "Implement a safer approval flow." },
  { label: "GitHub approval", goal: "Implement the fix and push the changes to GitHub." }
];

interface GoalInputProps {
  goal: string;
  onGoalChange: (goal: string) => void;
  onSubmit: (goal: string) => Promise<void>;
  busy: boolean;
}

export function GoalInput({ goal, onGoalChange, onSubmit, busy }: GoalInputProps) {
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = goal.trim();
    if (trimmed && !busy) await onSubmit(trimmed);
  }

  return (
    <section className="panel" id="goal-input">
      <form className="goal-row" onSubmit={submit}>
        <label className="sr-only" htmlFor="goal">Goal</label>
        <input
          id="goal"
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
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
            onClick={() => onGoalChange(preset.goal)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export const DEFAULT_GOAL = PRESETS[0].goal;
