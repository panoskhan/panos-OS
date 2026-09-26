import assert from "node:assert/strict";
import type { TaskEvent } from "../../packages/contracts/src/api";
import type { AgentHandler } from "../../services/agents/src/runtime";
import type { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

/**
 * A coding handler whose steps only finish when the test releases them,
 * so tests can observe a step while it is running without any timers.
 */
export function gatedHandler() {
  const waiting: Array<() => void> = [];
  const handler: AgentHandler = async (step, context) => {
    await new Promise<void>((resolve) => waiting.push(resolve));
    return {
      status: "success",
      summary: `Gated step '${step.id}' finished for goal: ${context.goal}`,
      findings: [`Finished ${step.id}`]
    };
  };
  return {
    handler,
    /** Lets the oldest running gated step finish. */
    releaseNext() {
      const release = waiting.shift();
      assert.ok(release, "no gated step is running");
      release();
    }
  };
}

/** Resolves with the first event (already recorded or future) that matches the predicate. */
export function waitForEvent(
  orchestrator: KhanOrchestrator,
  taskId: string,
  predicate: (event: TaskEvent) => boolean
): Promise<TaskEvent> {
  const existing = orchestrator.events(taskId).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const unsubscribe = orchestrator.subscribe(taskId, (event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

export const stepStarted = (stepId: string) => (event: TaskEvent) =>
  event.type === "step.started" && event.data.stepId === stepId;

/** Step lifecycle events as [type, stepId] pairs, in order. */
export function stepEvents(events: TaskEvent[]): Array<[string, unknown]> {
  return events.filter((event) => event.type.startsWith("step.")).map((event) => [event.type, event.data.stepId]);
}
