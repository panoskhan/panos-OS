import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer } from "../../apps/api/src/index";
import { ApiRequestError, createApiClient } from "../../apps/web/src/lib/api";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

test("web api client drives the full task loop against the real API", async () => {
  const orchestrator = new KhanOrchestrator();
  const server = createKhanApiServer(orchestrator);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = createApiClient(`http://127.0.0.1:${port}/`);

  /** Creates a task and waits until it pauses at the approval gate. */
  async function createPausedTask() {
    const created = await client.createTask({ goal: GITHUB_GOAL });
    assert.equal(created.task.status, "executing");
    await orchestrator.whenSettled(created.task.id);
    assert.equal((await client.getTask(created.task.id)).task.status, "waiting_approval");
    return created.task.id;
  }

  try {
    assert.deepEqual(await client.health(), { status: "ok", service: "khan-os-api" });

    const status = await client.getStatus();
    assert.equal(status.status, "ok");
    assert.deepEqual(status.components.map((component) => component.state), ["up", "not_configured", "up", "up", "up"]);

    const approvedId = await createPausedTask();
    const approved = await client.approveTask(approvedId);
    assert.equal(approved.task.status, "executing");
    await orchestrator.whenSettled(approvedId);
    assert.equal((await client.getTask(approvedId)).task.status, "completed");

    const { events } = await client.getTaskEvents(approvedId);
    assert.equal(events.at(-1)?.data.to, "completed");

    const rejected = await client.rejectTask(await createPausedTask(), "Not yet");
    assert.equal(rejected.task.status, "failed");
    assert.equal(rejected.verification.findings.at(-1), "Reason: Not yet");

    const cancelled = await client.cancelTask(await createPausedTask());
    assert.equal(cancelled.task.status, "cancelled");

    await assert.rejects(client.getTask("missing"), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "task_not_found");
      return true;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
