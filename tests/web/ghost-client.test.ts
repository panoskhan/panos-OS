import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer } from "../../apps/api/src/index";
import { ApiRequestError, createApiClient } from "../../apps/web/src/lib/api";
import { GhostRegistry, MIN_INTERVAL_MS } from "../../packages/core/src/ghost";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { ApiKeyAuth } from "../../services/auth/src/index";
import os from "node:os";
import path from "node:path";

let tmpSeq = 0;
/** A data dir of its own, so one test's ghosts never load into another's registry. */
function tmpDir(): string {
  return path.join(os.tmpdir(), `ghost-client-${process.pid}-${tmpSeq++}`);
}

/** Starts a server on a free port and hands back a client plus a shutdown. */
async function serve(auth?: ApiKeyAuth, key?: string) {
  const orchestrator = new KhanOrchestrator();
  const ghosts = new GhostRegistry(orchestrator, tmpDir());
  const server = createKhanApiServer(orchestrator, auth ? { auth, ghosts } : { ghosts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    client: createApiClient(`http://127.0.0.1:${port}`, key),
    async close() {
      ghosts.close(); // stop the timers, or the suite keeps firing ghosts after the server is gone
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

test("the web client drives a ghost through its whole life against the real API", async () => {
  const { client, close } = await serve();
  try {
    assert.deepEqual((await client.getGhosts()).ghosts, [], "a fresh registry holds no ghosts");

    const { ghost } = await client.registerGhost("sweep the audit log for refusals", {
      type: "interval",
      ms: 60_000
    });
    assert.equal(ghost.status, "active");
    assert.equal(ghost.goal, "sweep the audit log for refusals");
    assert.equal(ghost.fireCount, 0);
    assert.equal(ghost.schedule.ms, 60_000);

    const listed = (await client.getGhosts()).ghosts;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, ghost.id);

    // PATCH and DELETE are the two verbs the task routes never needed; this is what they were added for.
    assert.equal((await client.pauseGhost(ghost.id)).ghost.status, "paused");
    assert.equal((await client.resumeGhost(ghost.id)).ghost.status, "active");
    assert.equal((await client.removeGhost(ghost.id)).ghost.status, "deleted");

    assert.deepEqual((await client.getGhosts()).ghosts, [], "a retired ghost drops out of the roster");
  } finally {
    await close();
  }
});

test("the client surfaces the registry's refusals as ApiRequestError", async () => {
  const { client, close } = await serve();
  try {
    await assert.rejects(
      client.registerGhost("too eager", { type: "interval", ms: MIN_INTERVAL_MS - 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "interval_too_short");
        return true;
      }
    );

    await assert.rejects(client.pauseGhost("no-such-ghost"), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "ghost_not_found");
      return true;
    });

    await assert.rejects(client.removeGhost("no-such-ghost"), (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      return true;
    });
  } finally {
    await close();
  }
});

test("ghost routes need the API key when one is configured", async () => {
  const withKey = await serve(ApiKeyAuth.parse("web:ghost-key-7"), "ghost-key-7");
  const anonymous = createApiClient(withKey.client.baseUrl);
  try {
    const { ghost } = await withKey.client.registerGhost("keyed ghost", { type: "interval", ms: 60_000 });
    assert.ok(ghost.id.length > 0);

    for (const call of [
      () => anonymous.getGhosts(),
      () => anonymous.registerGhost("anonymous ghost", { type: "interval", ms: 60_000 }),
      () => anonymous.pauseGhost(ghost.id),
      () => anonymous.removeGhost(ghost.id)
    ]) {
      await assert.rejects(call(), (error: unknown) => {
        assert.ok(error instanceof ApiRequestError);
        assert.equal(error.status, 401);
        return true;
      });
    }

    // The unauthenticated attempts must not have changed anything.
    assert.equal((await withKey.client.getGhosts()).ghosts[0].status, "active");
  } finally {
    await withKey.close();
  }
});
