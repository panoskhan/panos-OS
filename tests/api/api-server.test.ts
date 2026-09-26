import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer } from "../../apps/api/src/index";
import type { TaskEventsResponse, TaskResponse } from "../../packages/contracts/src/api";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { gatedHandler, stepEvents, stepStarted, waitForEvent } from "../support/orchestration";

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

async function withApi(
  fn: (base: string, orchestrator: KhanOrchestrator) => Promise<void>,
  orchestrator = new KhanOrchestrator()
) {
  const server = createKhanApiServer(orchestrator);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, orchestrator);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function post(url: string, body?: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
  });
}

async function createTask(base: string, goal: string): Promise<TaskResponse> {
  const response = await post(`${base}/v1/tasks`, { goal });
  assert.equal(response.status, 201);
  return (await response.json()) as TaskResponse;
}

async function getTask(base: string, taskId: string): Promise<TaskResponse> {
  const response = await fetch(`${base}/v1/tasks/${taskId}`);
  assert.equal(response.status, 200);
  return (await response.json()) as TaskResponse;
}

/** Creates a task over HTTP and waits (via whenSettled) until its execution loop is idle. */
async function createSettledTask(base: string, orchestrator: KhanOrchestrator, goal: string): Promise<TaskResponse> {
  const created = await createTask(base, goal);
  await orchestrator.whenSettled(created.task.id);
  return getTask(base, created.task.id);
}

test("api serves health", async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "khan-os-api" });
  });
});

test("api create returns executing immediately, then the task completes in the background", async () => {
  await withApi(async (base, orchestrator) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    assert.equal(created.task.status, "executing");
    assert.deepEqual(created.execution, []);
    assert.match(created.task.id, /^task_[0-9a-f-]{36}$/);

    const settled = await orchestrator.whenSettled(created.task.id);
    assert.equal(settled.task.status, "completed");
    assert.equal(settled.verification.passed, true);
    assert.deepEqual(await getTask(base, created.task.id), settled);

    const eventsResponse = await fetch(`${base}/v1/tasks/${created.task.id}/events`);
    assert.equal(eventsResponse.status, 200);
    assert.match(eventsResponse.headers.get("content-type") ?? "", /application\/json/);
    const { taskId, events } = (await eventsResponse.json()) as TaskEventsResponse;
    assert.equal(taskId, created.task.id);
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    assert.equal(events[0]?.type, "task.created");
    assert.deepEqual(
      events.filter((event) => event.type === "task.status_changed").map((event) => event.data.to),
      ["understanding", "planning", "executing", "verifying", "completed"]
    );
    assert.deepEqual(stepEvents(events), [
      ["step.started", "inspect"],
      ["step.completed", "inspect"],
      ["step.started", "analyze"],
      ["step.completed", "analyze"],
      ["step.started", "qa"],
      ["step.completed", "qa"]
    ]);
  });
});

test("api GET shows the step that is currently running", async () => {
  const gate = gatedHandler();
  await withApi(async (base, orchestrator) => {
    const created = await createTask(base, ANALYSIS_GOAL);

    await waitForEvent(orchestrator, created.task.id, stepStarted("inspect"));
    const running = await getTask(base, created.task.id);
    assert.equal(running.task.status, "executing");
    assert.deepEqual(running.execution.map((entry) => [entry.stepId, entry.status]), [["inspect", "running"]]);

    gate.releaseNext();
    await waitForEvent(orchestrator, created.task.id, stepStarted("analyze"));
    assert.deepEqual((await getTask(base, created.task.id)).execution.map((entry) => [entry.stepId, entry.status]), [
      ["inspect", "completed"],
      ["analyze", "running"]
    ]);

    gate.releaseNext();
    await orchestrator.whenSettled(created.task.id);
    assert.equal((await getTask(base, created.task.id)).task.status, "completed");
  }, new KhanOrchestrator(undefined, undefined, gate.handler));
});

test("api assigns unique task ids", async () => {
  await withApi(async (base, orchestrator) => {
    const [first, second] = await Promise.all([createTask(base, ANALYSIS_GOAL), createTask(base, ANALYSIS_GOAL)]);
    assert.notEqual(first.task.id, second.task.id);
    await Promise.all([orchestrator.whenSettled(first.task.id), orchestrator.whenSettled(second.task.id)]);
  });
});

test("api approval returns 202 and resumes the gated step in the background", async () => {
  await withApi(async (base, orchestrator) => {
    const created = await createSettledTask(base, orchestrator, GITHUB_GOAL);
    assert.equal(created.task.status, "waiting_approval");
    assert.deepEqual(created.verification.checks, ["approval-required"]);

    const approved = await post(`${base}/v1/tasks/${created.task.id}/approve`);
    assert.equal(approved.status, 202);
    assert.equal(((await approved.json()) as TaskResponse).task.status, "executing");

    await orchestrator.whenSettled(created.task.id);
    const report = await getTask(base, created.task.id);
    assert.equal(report.task.status, "completed");
    assert.equal(report.verification.passed, true);
    assert.deepEqual(report.execution.map((entry) => [entry.stepId, entry.status]), [
      ["inspect", "completed"],
      ["implement", "completed"],
      ["test", "completed"],
      ["qa", "completed"]
    ]);

    const again = await post(`${base}/v1/tasks/${created.task.id}/approve`);
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, "invalid_task_state");

    const { events } = (await (await fetch(`${base}/v1/tasks/${created.task.id}/events`)).json()) as TaskEventsResponse;
    const approval = events.find((event) => event.type === "task.approved");
    assert.deepEqual(approval?.data, {
      stepId: "implement",
      permissions: ["workspace.read", "workspace.write", "github.write"]
    });
  });
});

test("api rejection fails the task without running the gated step", async () => {
  await withApi(async (base, orchestrator) => {
    const created = await createSettledTask(base, orchestrator, GITHUB_GOAL);
    const rejected = await post(`${base}/v1/tasks/${created.task.id}/reject`, { reason: "Not ready to push" });
    assert.equal(rejected.status, 200);
    const report = (await rejected.json()) as TaskResponse;
    assert.equal(report.task.status, "failed");
    assert.deepEqual(report.verification.checks, ["approval-rejected"]);
    assert.deepEqual(report.verification.findings, ["Approval rejected for step: implement", "Reason: Not ready to push"]);
    assert.deepEqual(report.execution.map((entry) => [entry.stepId, entry.status]), [
      ["inspect", "completed"],
      ["implement", "waiting_approval"]
    ]);
  });
});

test("api cancels a waiting task and refuses to cancel finished tasks", async () => {
  await withApi(async (base, orchestrator) => {
    const waiting = await createSettledTask(base, orchestrator, GITHUB_GOAL);
    const cancelled = await post(`${base}/v1/tasks/${waiting.task.id}/cancel`);
    assert.equal(cancelled.status, 200);
    const report = (await cancelled.json()) as TaskResponse;
    assert.equal(report.task.status, "cancelled");
    assert.deepEqual(report.verification.checks, ["cancelled"]);

    assert.equal((await post(`${base}/v1/tasks/${waiting.task.id}/cancel`)).status, 409);
    assert.equal((await post(`${base}/v1/tasks/${waiting.task.id}/approve`)).status, 409);

    const completed = await createSettledTask(base, orchestrator, ANALYSIS_GOAL);
    assert.equal(completed.task.status, "completed");
    assert.equal((await post(`${base}/v1/tasks/${completed.task.id}/cancel`)).status, 409);
  });
});

test("api cancels a task while a step is running", async () => {
  const gate = gatedHandler();
  await withApi(async (base, orchestrator) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    await waitForEvent(orchestrator, created.task.id, stepStarted("inspect"));

    const cancelled = await post(`${base}/v1/tasks/${created.task.id}/cancel`, { reason: "Stop" });
    assert.equal(cancelled.status, 200);
    assert.equal(((await cancelled.json()) as TaskResponse).task.status, "cancelled");

    gate.releaseNext();
    await orchestrator.whenSettled(created.task.id);
    const report = await getTask(base, created.task.id);
    assert.equal(report.task.status, "cancelled");
    assert.deepEqual(report.execution.map((entry) => [entry.stepId, entry.status]), [["inspect", "completed"]]);
  }, new KhanOrchestrator(undefined, undefined, gate.handler));
});

test("api allows CORS only for configured browser origins", async () => {
  await withApi(async (base) => {
    const allowed = "http://127.0.0.1:5173";
    const preflight = await fetch(`${base}/v1/tasks`, {
      method: "OPTIONS",
      headers: { origin: allowed, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), allowed);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type");

    const health = await fetch(`${base}/health`, { headers: { origin: allowed } });
    assert.equal(health.headers.get("access-control-allow-origin"), allowed);

    const missing = await fetch(`${base}/v1/tasks/missing`, { headers: { origin: allowed } });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("access-control-allow-origin"), allowed);

    const foreign = await fetch(`${base}/health`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  });
});

test("api rejects invalid requests", async () => {
  await withApi(async (base) => {
    const cases: Array<[Promise<Response>, number, string]> = [
      [post(`${base}/v1/tasks`, "{not json"), 400, "invalid_json"],
      [post(`${base}/v1/tasks`, {}), 400, "goal_required"],
      [post(`${base}/v1/tasks`, { goal: "   " }), 400, "goal_required"],
      [post(`${base}/v1/tasks`, ["goal"]), 400, "invalid_body"],
      [post(`${base}/v1/tasks`, { goal: "Analyze", projectId: 7 }), 400, "invalid_project_id"],
      [post(`${base}/v1/tasks`, "x".repeat(1024 * 1024 + 1)), 413, "payload_too_large"],
      [fetch(`${base}/v1/tasks`), 405, "method_not_allowed"],
      [fetch(`${base}/v1/tasks/missing`), 404, "task_not_found"],
      [fetch(`${base}/v1/tasks/missing/events`), 404, "task_not_found"],
      [post(`${base}/v1/tasks/missing/approve`), 404, "task_not_found"],
      [fetch(`${base}/v1/tasks/missing/approve`), 405, "method_not_allowed"],
      [fetch(`${base}/v1/unknown`), 404, "not_found"]
    ];

    for (const [request, status, error] of cases) {
      const response = await request;
      assert.equal(response.status, status, `expected ${status} for ${response.url}`);
      assert.equal(((await response.json()) as { error: string }).error, error);
    }
  });
});
