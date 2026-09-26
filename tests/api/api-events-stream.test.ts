import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer, type KhanApiServerOptions } from "../../apps/api/src/index";
import type { TaskEvent, TaskResponse } from "../../packages/contracts/src/api";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { TaskStore } from "../../services/orchestrator/src/task-store";
import { gatedHandler, stepEvents, stepStarted, waitForEvent } from "../support/orchestration";

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
  retry?: string;
  comment?: string;
}

/** A minimal Server-Sent Events reader over a real fetch response body. */
async function openStream(url: string, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { accept: "text/event-stream", ...headers }, signal: controller.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  async function next(): Promise<SseFrame | null> {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += value;
    }
    const end = buffer.indexOf("\n\n");
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);

    const frame: SseFrame = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) frame.comment = line.slice(1).trim();
      else {
        const [field, ...rest] = line.split(":");
        (frame as Record<string, string>)[field] = rest.join(":").trimStart();
      }
    }
    return frame;
  }

  /** Reads task event frames until one matches, returning every event read. */
  async function readEventsUntil(predicate: (event: TaskEvent) => boolean): Promise<TaskEvent[]> {
    const events: TaskEvent[] = [];
    for (;;) {
      const frame = await next();
      assert.ok(frame, "stream closed before the expected event");
      if (!frame.data || frame.event) continue;
      const event = JSON.parse(frame.data) as TaskEvent;
      assert.equal(frame.id, String(event.seq));
      events.push(event);
      if (predicate(event)) return events;
    }
  }

  return { response, next, readEventsUntil, close: () => controller.abort() };
}

async function withApi(
  fn: (base: string, orchestrator: KhanOrchestrator) => Promise<void>,
  orchestrator = new KhanOrchestrator(),
  options: KhanApiServerOptions = {}
) {
  const server = createKhanApiServer(orchestrator, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, orchestrator);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function createTask(base: string, goal: string): Promise<TaskResponse> {
  const response = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal })
  });
  assert.equal(response.status, 201);
  return (await response.json()) as TaskResponse;
}

const isTerminalStatus = (event: TaskEvent) =>
  event.type === "task.status_changed" && ["completed", "failed", "cancelled"].includes(event.data.to as string);

test("event stream replays a finished task's history, sends end, and closes", async () => {
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, ANALYSIS_GOAL);
    await orchestrator.whenSettled(task.id);

    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`);
    assert.equal(stream.response.status, 200);
    assert.match(stream.response.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.equal(stream.response.headers.get("cache-control"), "no-cache, no-transform");
    assert.deepEqual(await stream.next(), { retry: "2000" });

    const replayed = await stream.readEventsUntil(isTerminalStatus);
    assert.deepEqual(replayed, orchestrator.events(task.id));
    assert.deepEqual(await stream.next(), { event: "end", data: "{}" });
    assert.equal(await stream.next(), null);
  });
});

test("event stream delivers live step events in order as each step finishes", async () => {
  const gate = gatedHandler();
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, ANALYSIS_GOAL);
    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`);

    const received = await stream.readEventsUntil(stepStarted("inspect"));
    gate.releaseNext();
    received.push(...(await stream.readEventsUntil(stepStarted("analyze"))));
    gate.releaseNext();
    received.push(...(await stream.readEventsUntil(isTerminalStatus)));

    assert.deepEqual(stepEvents(received), [
      ["step.started", "inspect"],
      ["step.completed", "inspect"],
      ["step.started", "analyze"],
      ["step.completed", "analyze"],
      ["step.started", "qa"],
      ["step.completed", "qa"]
    ]);
    assert.deepEqual(received.map((event) => event.seq), received.map((_, index) => index + 1));
    assert.deepEqual(received, orchestrator.events(task.id));
    assert.deepEqual(await stream.next(), { event: "end", data: "{}" });
    assert.equal(await stream.next(), null);
  }, new KhanOrchestrator(undefined, undefined, gate.handler));
});

test("event stream stays open through approval and streams the resumed steps", async () => {
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, GITHUB_GOAL);
    const paused = await orchestrator.whenSettled(task.id);
    assert.equal(paused.task.status, "waiting_approval");
    const historyLength = orchestrator.events(task.id).length;

    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`);
    await stream.readEventsUntil((event) => event.seq === historyLength);

    const approved = await fetch(`${base}/v1/tasks/${task.id}/approve`, { method: "POST" });
    assert.equal(approved.status, 202);

    const resumed = await stream.readEventsUntil(isTerminalStatus);
    assert.equal(resumed[0].type, "task.approved");
    assert.deepEqual(stepEvents(resumed), [
      ["step.started", "implement"],
      ["step.completed", "implement"],
      ["step.started", "test"],
      ["step.completed", "test"],
      ["step.started", "qa"],
      ["step.completed", "qa"]
    ]);
    assert.equal(resumed.at(-1)?.data.to, "completed");
    assert.deepEqual(await stream.next(), { event: "end", data: "{}" });
  });
});

test("event stream resumes after Last-Event-ID without repeating events", async () => {
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, ANALYSIS_GOAL);
    await orchestrator.whenSettled(task.id);

    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`, { "last-event-id": "5" });
    await stream.next(); // retry
    const resumed = await stream.readEventsUntil(isTerminalStatus);

    assert.deepEqual(resumed, orchestrator.events(task.id).slice(5));
    assert.equal(resumed[0].seq, 6);
    assert.deepEqual(await stream.next(), { event: "end", data: "{}" });
  });
});

test("event stream for an already-finished task caught up via Last-Event-ID just ends", async () => {
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, ANALYSIS_GOAL);
    await orchestrator.whenSettled(task.id);
    const lastSeq = orchestrator.events(task.id).length;

    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`, { "last-event-id": String(lastSeq) });

    assert.deepEqual(await stream.next(), { retry: "2000" });
    assert.deepEqual(await stream.next(), { event: "end", data: "{}" });
    assert.equal(await stream.next(), null);
  });
});

test("events endpoint still returns JSON unless the client asks for a stream", async () => {
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, ANALYSIS_GOAL);
    await orchestrator.whenSettled(task.id);

    const response = await fetch(`${base}/v1/tasks/${task.id}/events`, { headers: { accept: "application/json" } });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { taskId: task.id, events: orchestrator.events(task.id) });
  });
});

test("event stream for an unknown task returns a JSON 404", async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/v1/tasks/missing/events`, { headers: { accept: "text/event-stream" } });

    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(((await response.json()) as { error: string }).error, "task_not_found");
  });
});

test("event stream sends CORS headers and keep-alive heartbeats while a task waits", async () => {
  await withApi(
    async (base, orchestrator) => {
      const { task } = await createTask(base, GITHUB_GOAL);
      await orchestrator.whenSettled(task.id);

      const stream = await openStream(`${base}/v1/tasks/${task.id}/events`, { origin: "http://127.0.0.1:5173" });
      assert.equal(stream.response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

      let frame = await stream.next();
      while (frame && frame.comment === undefined) frame = await stream.next();
      assert.deepEqual(frame, { comment: "keep-alive" });
      stream.close();
    },
    new KhanOrchestrator(),
    { heartbeatMs: 20 }
  );
});

test("event stream unsubscribes when the client disconnects", async () => {
  const store = new TaskStore();
  await withApi(async (base, orchestrator) => {
    const { task } = await createTask(base, GITHUB_GOAL);
    await orchestrator.whenSettled(task.id);

    const stream = await openStream(`${base}/v1/tasks/${task.id}/events`);
    await stream.readEventsUntil((event) => event.type === "step.waiting_approval");
    assert.equal(store.listenerCount(task.id), 1);

    stream.close();
    // The server sees the disconnect asynchronously; yield to the event loop until it does.
    for (let turn = 0; turn < 1000 && store.listenerCount(task.id) > 0; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(store.listenerCount(task.id), 0);
  }, new KhanOrchestrator(undefined, undefined, undefined, store));
});
