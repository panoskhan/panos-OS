import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer } from "../../apps/api/src/index";
import { ApiRequestError, createApiClient } from "../../apps/web/src/lib/api";

const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

test("web api client drives the full task loop against the real API", async () => {
  const server = createKhanApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = createApiClient(`http://127.0.0.1:${port}/`);

  try {
    assert.deepEqual(await client.health(), { status: "ok", service: "khan-os-api" });

    const created = await client.createTask({ goal: GITHUB_GOAL });
    assert.equal(created.task.status, "waiting_approval");
    assert.equal((await client.getTask(created.task.id)).task.status, "waiting_approval");

    const approved = await client.approveTask(created.task.id);
    assert.equal(approved.task.status, "completed");

    const { events } = await client.getTaskEvents(created.task.id);
    assert.equal(events.at(-1)?.data.to, "completed");

    const rejected = await client.rejectTask((await client.createTask({ goal: GITHUB_GOAL })).task.id, "Not yet");
    assert.equal(rejected.verification.findings.at(-1), "Reason: Not yet");

    const cancelled = await client.cancelTask((await client.createTask({ goal: GITHUB_GOAL })).task.id);
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
