import assert from "node:assert/strict";
import test from "node:test";
import type { TaskEvent } from "../../packages/contracts/src/api";
import { TaskStore, type TaskRecord } from "../../services/orchestrator/src/task-store";

function record(id: string): TaskRecord {
  return {
    report: {
      task: { id, projectId: "default", goal: "goal", status: "received", risk: "read", requiredAgents: [], createdAt: "" },
      plan: [],
      execution: [],
      verification: { passed: false, checks: [], findings: [] }
    },
    agentResults: [],
    completedSteps: new Set(),
    nextStepIndex: 0,
    approvedPermissions: new Set(),
    events: []
  };
}

test("task store notifies only the subscribers of that task", () => {
  const store = new TaskStore();
  const first = record("task_a");
  const second = record("task_b");
  store.add(first);
  store.add(second);
  const received: TaskEvent[] = [];
  store.subscribe("task_a", (event) => received.push(event));

  store.appendEvent(first, "task.created", { goal: "a" });
  store.appendEvent(second, "task.created", { goal: "b" });
  store.appendEvent(first, "plan.created", { steps: [] });

  assert.deepEqual(received.map((event) => [event.taskId, event.seq, event.type]), [
    ["task_a", 1, "task.created"],
    ["task_a", 2, "plan.created"]
  ]);
});

test("task store unsubscribe stops notifications and releases the listener", () => {
  const store = new TaskStore();
  const task = record("task_a");
  store.add(task);
  const received: TaskEvent[] = [];
  const unsubscribe = store.subscribe("task_a", (event) => received.push(event));
  assert.equal(store.listenerCount("task_a"), 1);

  unsubscribe();
  store.appendEvent(task, "task.created");

  assert.equal(received.length, 0);
  assert.equal(store.listenerCount("task_a"), 0);
});

test("task store listeners get copies and a throwing listener does not stop the others", (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const store = new TaskStore();
  const task = record("task_a");
  store.add(task);
  const received: TaskEvent[] = [];
  store.subscribe("task_a", (event) => {
    event.data.mutated = true;
    throw new Error("listener broke");
  });
  store.subscribe("task_a", (event) => received.push(event));

  const appended = store.appendEvent(task, "task.created", { goal: "a" });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, { goal: "a" });
  assert.deepEqual(appended.data, { goal: "a" });
  assert.equal(errors.mock.callCount(), 1);
});
