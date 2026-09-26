import { useEffect, useRef } from "react";
import type { TaskEvent } from "../../../../packages/contracts/src/api";

interface EventTimelineProps {
  taskId: string | undefined;
  events: TaskEvent[];
}

function describe(event: TaskEvent): string {
  const { data } = event;
  switch (event.type) {
    case "task.status_changed":
      return `${data.from} → ${data.to}`;
    case "plan.created":
      return `${(data.steps as string[]).join(" → ")} · risk ${data.risk}`;
    case "step.started":
    case "step.completed":
    case "step.failed":
    case "step.waiting_approval":
      return `${data.stepId} (${data.agent})`;
    case "task.approved":
      return `${data.stepId} · ${(data.permissions as string[]).join(", ")}`;
    case "task.rejected":
      return `${data.stepId}${data.reason ? ` · ${data.reason}` : ""}`;
    case "task.cancelled":
      return data.reason ? String(data.reason) : "";
    case "task.created":
      return String(data.goal);
    default:
      return JSON.stringify(data);
  }
}

/** The "Live agent activity" log: the task's real event stream, newest at the bottom. */
export function EventTimeline({ taskId, events }: EventTimelineProps) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [events]);

  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <header className="panel-head">
        <h2 id="activity-title">Live agent activity</h2>
        <span className="muted">{events.length} events</span>
      </header>
      {!taskId ? (
        <p className="empty">Every planner, agent and QA event appears here as it happens.</p>
      ) : (
        <ol className="timeline" ref={listRef}>
          {events.map((event) => (
            <li key={event.seq} data-type={event.type}>
              <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>
              <code className="event-type">{event.type}</code>
              <span className="event-data">{describe(event)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
