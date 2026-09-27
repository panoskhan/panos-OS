import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createKhanApiServer } from "../../apps/api/src/index";
import { ApiRequestError, createApiClient, type KhanApiClient } from "../../apps/web/src/lib/api";
import { TASK_GONE_MESSAGE, TaskSync, type Connection, type TaskSyncOptions } from "../../apps/web/src/lib/taskSync";
import type { TaskEvent, TaskResponse } from "../../packages/contracts/src/api";
import type { AgentHandler } from "../../services/agents/src/runtime";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { TaskStore } from "../../services/orchestrator/src/task-store";
import { gatedHandler } from "../support/orchestration";

// TaskSync uses the browser's EventSource. Node provides it behind a flag, which `npm test` passes.
assert.equal(typeof EventSource, "function", "run with node --experimental-eventsource (npm test does)");

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

interface Live {
  base: string;
  server: Server;
  orchestrator: KhanOrchestrator;
  store: TaskStore;
  client: KhanApiClient;
}

async function withLive(fn: (live: Live) => Promise<void>, handler?: AgentHandler) {
  const store = new TaskStore();
  const orchestrator = new KhanOrchestrator(undefined, undefined, handler, store);
  const server = createKhanApiServer(orchestrator, { retryMs: 10 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn({ base, server, orchestrator, store, client: createApiClient(base) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

/** Records everything a TaskSync reports, and lets a test wait for a condition without timers. */
class Watch {
  reports: TaskResponse[] = [];
  events: TaskEvent[] = [];
  connections: Connection[] = [];
  errors: Array<string | null> = [];
  /** Wall-clock time (ms) each step was first seen `running`. */
  runningSeenAt = new Map<string, number>();
  private waiters: Array<{ check: () => boolean; resolve: () => void }> = [];

  get report(): TaskResponse | undefined {
    return this.reports.at(-1);
  }

  handlers(): Pick<TaskSyncOptions, "onReport" | "onEvents" | "onConnection" | "onError"> {
    return {
      onReport: (report) => {
        this.reports.push(report);
        for (const entry of report.execution) {
          if (entry.status === "running" && !this.runningSeenAt.has(entry.stepId)) this.runningSeenAt.set(entry.stepId, Date.now());
        }
        this.notify();
      },
      onEvents: (events) => {
        this.events = events;
        this.notify();
      },
      onConnection: (connection) => {
        this.connections.push(connection);
        this.notify();
      },
      onError: (message) => {
        this.errors.push(message);
        this.notify();
      }
    };
  }

  until(check: () => boolean): Promise<void> {
    if (check()) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ check, resolve }));
  }

  private notify(): void {
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.check()) return true;
      waiter.resolve();
      return false;
    });
  }
}

function counting(client: KhanApiClient) {
  const calls = { getTask: 0, getTaskEvents: 0 };
  const wrapped: KhanApiClient = {
    ...client,
    getTask: (id) => (calls.getTask++, client.getTask(id)),
    getTaskEvents: (id) => (calls.getTaskEvents++, client.getTaskEvents(id))
  };
  return { calls, client: wrapped };
}

const stepStartedAt = (events: TaskEvent[]) =>
  new Map(events.filter((event) => event.type === "step.started").map((event) => [String(event.data.stepId), Date.parse(event.at)]));

test("live stream shows each step running within 200ms of step.started, with no polling", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client, orchestrator }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    const watch = new Watch();
    // A poll interval this long means every update below had to come from the stream.
    const sync = new TaskSync({ client, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.runningSeenAt.has("inspect"));
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      gate.releaseNext();
      // The gate only holds the coding agent's steps; QA then runs instantly and the task completes.
      await watch.until(() => watch.report?.task.status === "completed");
      await watch.until(() => watch.connections.at(-1) === "idle");

      // "analyze" starts the moment the test releases "inspect", so its step.started is emitted right then.
      const startedAt = stepStartedAt(orchestrator.events(task.id));
      const latency = watch.runningSeenAt.get("analyze")! - startedAt.get("analyze")!;
      assert.ok(latency < 200, `analyze showed running ${latency}ms after step.started (limit 200ms)`);
      assert.deepEqual(watch.connections, ["connecting", "live", "idle"]);
      assert.deepEqual(watch.events, orchestrator.events(task.id));
    } finally {
      sync.stop();
    }
  }, gate.handler);
});

test("a step shows running before the confirming read returns", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client }) => {
    const created = await client.createTask({ goal: ANALYSIS_GOAL });
    assert.deepEqual(created.execution, [], "the create response is from before any step started");

    // Hold every read of the task until the test lets them go: anything shown meanwhile came from the stream alone.
    const heldReads: Array<() => void> = [];
    const held: KhanApiClient = {
      ...client,
      getTask: (id) => new Promise((resolve) => heldReads.push(() => resolve(client.getTask(id))))
    };
    const watch = new Watch();
    const sync = new TaskSync({ client: held, taskId: created.task.id, initialReport: created, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.runningSeenAt.has("inspect"));
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      assert.ok(heldReads.length >= 1, "a confirming read was requested");
      assert.deepEqual(
        watch.report?.execution.map((entry) => [entry.stepId, entry.status]),
        [["inspect", "completed"], ["analyze", "running"]],
        "shown from the events alone"
      );

      gate.releaseNext();
      for (const release of heldReads.splice(0)) release(); // now the confirming reads return
      await watch.until(() => watch.report?.task.status === "completed");
      assert.equal(watch.report?.execution.every((entry) => entry.output !== undefined), true, "the read fills in step output");
    } finally {
      sync.stop();
      for (const release of heldReads.splice(0)) release();
    }
  }, gate.handler);
});

test("a late step event never moves a step backwards", { timeout: 15000 }, async () => {
  await withLive(async ({ client, orchestrator }) => {
    const { task } = await client.createTask({ goal: GITHUB_GOAL });
    await orchestrator.whenSettled(task.id); // paused at the approval gate
    const waiting = await client.getTask(task.id);
    assert.deepEqual(waiting.execution.map((entry) => [entry.stepId, entry.status]), [["inspect", "completed"], ["implement", "waiting_approval"]]);

    // Only the stream is faked, so messages can be delivered in any order the test likes.
    const fake = {
      readyState: 1,
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
      addEventListener() {},
      close() {}
    };
    const message = (seq: number, type: string, stepId: string) =>
      fake.onmessage?.({ data: JSON.stringify({ seq, taskId: task.id, type, at: new Date().toISOString(), data: { stepId, agent: "coding" } }) });
    const watch = new Watch();
    const sync = new TaskSync({ client, taskId: task.id, initialReport: waiting, pollIntervalMs: 60_000, createEventSource: () => fake, ...watch.handlers() });
    sync.start();
    try {
      message(1, "step.started", "inspect"); // stale: inspect already completed
      assert.equal(watch.reports.length, 0, "a stale event changes nothing");

      message(2, "step.started", "implement"); // forward: waiting_approval -> running
      assert.equal(watch.reports.length, 1);
      assert.equal(watch.report?.execution.find((entry) => entry.stepId === "implement")?.status, "running");

      message(3, "step.waiting_approval", "implement"); // stale: it is already running
      assert.equal(watch.reports.length, 1, "a step never goes back to an earlier status");
    } finally {
      sync.stop();
    }
  });
});

test("the end message closes the stream and leaves the final report", { timeout: 15000 }, async () => {
  await withLive(async ({ client, orchestrator, store }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    const watch = new Watch();
    const sync = new TaskSync({ client, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.connections.at(-1) === "idle" && watch.report?.task.status === "completed");

      assert.equal(watch.report?.verification.passed, true);
      assert.deepEqual(watch.events, orchestrator.events(task.id));
      assert.equal(store.listenerCount(task.id), 0, "server released the stream's listener");
      assert.equal(watch.errors.at(-1), null);
    } finally {
      sync.stop();
    }
  });
});

test("live stream stays open through an approval gate and resumes after approve", { timeout: 15000 }, async () => {
  await withLive(async ({ client, orchestrator }) => {
    const { task } = await client.createTask({ goal: GITHUB_GOAL });
    const watch = new Watch();
    const sync = new TaskSync({ client, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.report?.task.status === "waiting_approval");
      assert.equal(watch.connections.at(-1), "live", "stream is still open while waiting for a decision");

      await client.approveTask(task.id);
      await watch.until(() => watch.report?.task.status === "completed");
      await watch.until(() => watch.connections.at(-1) === "idle");

      assert.deepEqual(watch.report?.execution.map((entry) => [entry.stepId, entry.status]), [
        ["inspect", "completed"],
        ["implement", "completed"],
        ["test", "completed"],
        ["qa", "completed"]
      ]);
      assert.deepEqual(watch.events, orchestrator.events(task.id));
      assert.ok(!watch.connections.includes("polling"));
    } finally {
      sync.stop();
    }
  });
});

test("reconnects after the server drops the stream, with no duplicate or missing events", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client, server, orchestrator }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    const watch = new Watch();
    const sync = new TaskSync({ client, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.runningSeenAt.has("inspect") && watch.connections.at(-1) === "live");

      server.closeAllConnections(); // the stream drops mid-run
      await watch.until(() => watch.connections.includes("connecting") && watch.connections.at(-1) === "live");

      // Steps finished while the stream was down (or after it came back) still arrive, once each.
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      gate.releaseNext();
      await watch.until(() => watch.report?.task.status === "completed");
      await watch.until(() => watch.connections.at(-1) === "idle");

      const serverEvents = orchestrator.events(task.id);
      assert.deepEqual(watch.events.map((event) => event.seq), serverEvents.map((event) => event.seq));
      assert.deepEqual(watch.events, serverEvents);
      assert.equal(watch.errors.at(-1), null);
    } finally {
      sync.stop();
    }
  }, gate.handler);
});

test("falls back to polling when the event stream fails for good", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client, base, orchestrator }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    // The stream URL 404s, so the browser gives up on it. This is a real HTTP failure, not a mock.
    const noStream: KhanApiClient = { ...client, eventsUrl: (id) => `${base}/v1/tasks/${id}/no-such-stream` };
    const watch = new Watch();
    const sync = new TaskSync({ client: noStream, taskId: task.id, pollIntervalMs: 15, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.connections.includes("polling"));
      await watch.until(() => watch.runningSeenAt.has("inspect"));
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      gate.releaseNext();
      await watch.until(() => watch.report?.task.status === "completed");
      await watch.until(() => watch.connections.at(-1) === "idle");

      assert.ok(!watch.connections.includes("live"));
      // The log is filled from the JSON events endpoint while polling.
      assert.deepEqual(watch.events, orchestrator.events(task.id));
    } finally {
      sync.stop();
    }
  }, gate.handler);
});

test("repeated stream errors do not flip a polling task back to connecting", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    // Only the stream is faked (to raise errors on demand); every read still goes to the real API.
    const fake = {
      readyState: 0,
      onopen: null as ((event: unknown) => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null as ((event: unknown) => void) | null,
      addEventListener() {},
      close() {
        this.readyState = 2;
      }
    };
    const watch = new Watch();
    const sync = new TaskSync({ client, taskId: task.id, pollIntervalMs: 10, createEventSource: () => fake, ...watch.handlers() });
    sync.start();
    try {
      fake.onerror?.({}); // the first failure: connecting, polling covers it
      await watch.until(() => watch.connections.at(-1) === "polling");
      fake.onerror?.({}); // the browser's next failed retry
      fake.onerror?.({});
      assert.deepEqual(watch.connections, ["connecting", "polling"]);

      fake.onopen?.({}); // the stream recovers
      assert.equal(watch.connections.at(-1), "live");
    } finally {
      sync.stop();
      gate.releaseNext(); // let the held step finish so the server can shut down cleanly
    }
  }, gate.handler);
});

test("opening a finished task replays its events and closes without re-reading it", { timeout: 15000 }, async () => {
  await withLive(async ({ client, orchestrator }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    await orchestrator.whenSettled(task.id);
    const finished = await client.getTask(task.id);
    assert.equal(finished.task.status, "completed");

    const spy = counting(client);
    const watch = new Watch();
    const sync = new TaskSync({ client: spy.client, taskId: task.id, terminal: true, ...watch.handlers() });
    sync.start();
    try {
      const serverEvents = orchestrator.events(task.id);
      await watch.until(() => watch.events.length === serverEvents.length && watch.connections.at(-1) === "idle");

      assert.deepEqual(watch.events, serverEvents);
      assert.equal(spy.calls.getTask, 0, "a terminal task is never re-read");
    } finally {
      sync.stop();
    }
  });
});

test("a burst of events causes far fewer reads than events", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client, orchestrator }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    const spy = counting(client);
    const watch = new Watch();
    const sync = new TaskSync({ client: spy.client, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      // Task creation already produced several events (created, status changes, plan, step.started).
      const backlog = orchestrator.events(task.id).length;
      await watch.until(() => watch.events.length >= backlog && watch.runningSeenAt.has("inspect"));

      assert.ok(backlog >= 5, `expected a burst, got ${backlog} events`);
      assert.ok(spy.calls.getTask < backlog, `${spy.calls.getTask} reads for ${backlog} events`);
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      gate.releaseNext();
      await watch.until(() => watch.report?.task.status === "completed");
    } finally {
      sync.stop();
    }
  }, gate.handler);
});

test("stop() prevents a slow read from applying after the task was switched away", { timeout: 15000 }, async () => {
  await withLive(async ({ client }) => {
    const { task } = await client.createTask({ goal: ANALYSIS_GOAL });
    const real = await client.getTask(task.id);

    let release!: (report: TaskResponse) => void;
    let requested!: () => void;
    const requestSeen = new Promise<void>((resolve) => (requested = resolve));
    const slow: KhanApiClient = {
      ...client,
      getTask: () =>
        new Promise<TaskResponse>((resolve) => {
          release = resolve;
          requested();
        })
    };

    const watch = new Watch();
    const sync = new TaskSync({ client: slow, taskId: task.id, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    await requestSeen;
    const inFlight = sync.refresh();

    sync.stop(); // the user opened a different task
    release(real); // the old task's response finally arrives
    await inFlight;

    assert.equal(watch.reports.length, 0, "a stopped sync must not report");
  });
});

test("when the API rate limits reads, the sync stays quiet for the wait, then catches up and clears the message", { timeout: 15000 }, async () => {
  const gate = gatedHandler();
  await withLive(async ({ client }) => {
    const created = await client.createTask({ goal: ANALYSIS_GOAL });
    let refused = 0;
    let readsWhilePaused = 0;
    let pausedAt = 0;
    const limited: KhanApiClient = {
      ...client,
      getTask: async (id) => {
        if (refused < 1) {
          refused++;
          pausedAt = Date.now();
          throw new ApiRequestError(429, "rate_limited", "too many requests", 60);
        }
        if (Date.now() - pausedAt < 60) readsWhilePaused++;
        return client.getTask(id);
      }
    };
    const watch = new Watch();
    const sync = new TaskSync({ client: limited, taskId: created.task.id, initialReport: created, pollIntervalMs: 60_000, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.errors.some((message) => message?.includes("rate limiting")));
      assert.match(String(watch.errors.at(-1)), /Retrying in 1s\./, "the wait is shown, rounded up to whole seconds");

      // Events keep arriving meanwhile (the stream needs no request), yet no read is sent until the wait is over.
      await watch.until(() => watch.events.length >= 6);
      void sync.refresh();
      assert.equal(readsWhilePaused, 0, "no read during the wait");

      // After the wait, one read catches up, and the message is cleared by that success.
      await watch.until(() => watch.runningSeenAt.has("inspect") && watch.errors.at(-1) === null);
      assert.equal(refused, 1);
      gate.releaseNext();
      await watch.until(() => watch.runningSeenAt.has("analyze"));
      gate.releaseNext();
      await watch.until(() => watch.report?.task.status === "completed");
    } finally {
      sync.stop();
    }
  }, gate.handler);
});

test("a task the server no longer knows stops the sync with an explanation", { timeout: 15000 }, async () => {
  await withLive(async ({ client }) => {
    const spy = counting(client);
    const watch = new Watch();
    const sync = new TaskSync({ client: spy.client, taskId: "task_missing", pollIntervalMs: 10, ...watch.handlers() });
    sync.start();
    try {
      await watch.until(() => watch.errors.includes(TASK_GONE_MESSAGE));

      assert.equal(watch.connections.at(-1), "idle");
      assert.equal(watch.reports.length, 0);
    } finally {
      sync.stop();
    }
  });
});
