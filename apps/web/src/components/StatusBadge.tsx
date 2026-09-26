type Tone = "ok" | "warn" | "danger" | "active" | "idle";

const tones: Record<string, Tone> = {
  completed: "ok",
  passed: "ok",
  waiting_approval: "warn",
  failed: "danger",
  cancelled: "idle",
  pending: "idle",
  received: "active",
  understanding: "active",
  planning: "active",
  executing: "active",
  verifying: "active"
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className="badge" data-tone={tones[status] ?? "idle"}>
      {label ?? status.replaceAll("_", " ")}
    </span>
  );
}
