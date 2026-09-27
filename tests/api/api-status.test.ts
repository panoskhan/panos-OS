import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createKhanApiServer, type KhanApiServerOptions } from "../../apps/api/src/index";
import type { ComponentStatus, StatusResponse, TaskResponse } from "../../packages/contracts/src/api";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

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

async function getStatus(base: string, headers: Record<string, string> = {}): Promise<{ response: Response; status: StatusResponse }> {
  const response = await fetch(`${base}/v1/status`, { headers });
  return { response, status: (await response.json()) as StatusResponse };
}

const byId = (status: StatusResponse, id: string): ComponentStatus => status.components.find((entry) => entry.id === id)!;

test("GET /v1/status reports the seven components from the live server", async () => {
  await withApi(async (base) => {
    const { response, status } = await getStatus(base);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(status.status, "ok");
    assert.equal(status.service, "khan-os-api");
    assert.equal(status.version, packageVersion);
    assert.ok(Number.isInteger(status.uptimeSeconds) && status.uptimeSeconds >= 0);
    assert.ok(!Number.isNaN(Date.parse(status.checkedAt)));
    assert.deepEqual(
      status.components.map((entry) => [entry.id, entry.name, entry.state]),
      [
        ["orchestrator", "Orchestrator", "up"],
        ["model-router", "Model Router", "not_configured"],
        ["agents", "Agents", "up"],
        ["permissions", "Permissions", "up"],
        ["qa", "Independent QA", "up"],
        ["audit", "Audit Log", "not_configured"],
        ["rate-limiter", "Rate Limiter", "not_configured"] // tests run with every limit at 0 (tests/test.env)
      ]
    );
    for (const entry of status.components) assert.ok(entry.detail.length > 0, `${entry.id} explains itself`);
  });
});

test("uptime follows the server's clock", async () => {
  let now = 1_000_000;
  await withApi(
    async (base) => {
      const first = (await getStatus(base)).status;
      assert.equal(first.uptimeSeconds, 0);

      now += 42_000;
      const later = (await getStatus(base)).status;
      assert.equal(later.uptimeSeconds, 42);
      assert.match(byId(later, "orchestrator").detail, /^Up 42s\./);
      assert.equal(later.checkedAt, new Date(now).toISOString());
    },
    new KhanOrchestrator(),
    { clock: () => now }
  );
});

test("the orchestrator component counts real tasks over HTTP", async () => {
  await withApi(async (base, orchestrator) => {
    assert.deepEqual(byId((await getStatus(base)).status, "orchestrator").metrics, { tasks: 0, running: 0, waitingApproval: 0 });

    const created = (await (await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: GITHUB_GOAL })
    })).json()) as TaskResponse;
    await orchestrator.whenSettled(created.task.id);
    assert.deepEqual(byId((await getStatus(base)).status, "orchestrator").metrics, { tasks: 1, running: 0, waitingApproval: 1 });

    assert.equal((await fetch(`${base}/v1/tasks/${created.task.id}/approve`, { method: "POST" })).status, 202);
    await orchestrator.whenSettled(created.task.id);
    assert.deepEqual(byId((await getStatus(base)).status, "orchestrator").metrics, { tasks: 1, running: 0, waitingApproval: 0 });
  });
});

test("a broken component shows as degraded in the body while the response is still 200", async () => {
  class OrchestratorWithoutQa extends KhanOrchestrator {
    override diagnostics() {
      const live = super.diagnostics();
      return { ...live, registeredAgents: live.registeredAgents.filter((agent) => agent !== "qa") };
    }
  }

  await withApi(async (base) => {
    const { response, status } = await getStatus(base);

    assert.equal(response.status, 200);
    assert.equal(status.status, "degraded");
    assert.equal(byId(status, "agents").state, "down");
    assert.match(byId(status, "agents").detail, /No handler registered for: qa/);
    assert.equal(byId(status, "qa").state, "up");
  }, new OrchestratorWithoutQa());
});

test("status allows configured browser origins, rejects other methods, and leaves /health alone", async () => {
  await withApi(async (base) => {
    const allowed = "http://127.0.0.1:5173";
    const withOrigin = await fetch(`${base}/v1/status`, { headers: { origin: allowed } });
    assert.equal(withOrigin.headers.get("access-control-allow-origin"), allowed);
    const foreign = await fetch(`${base}/v1/status`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const post = await fetch(`${base}/v1/status`, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.equal(((await post.json()) as { error: string }).error, "method_not_allowed");

    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok", service: "khan-os-api" });
  });
});
