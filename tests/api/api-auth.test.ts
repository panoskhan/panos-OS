import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer, type KhanApiServerOptions } from "../../apps/api/src/index";
import type { AuditEntry, AuditResponse, StatusResponse, TaskResponse } from "../../packages/contracts/src/api";
import { ApiKeyAuth, AuthConfigError } from "../../services/auth/src/index";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

assert.equal(typeof EventSource, "function", "run with node --experimental-eventsource (npm test does)");

const KEYS = "admin:secret123,readonly:readkey456";
const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

async function withApi(fn: (base: string, orchestrator: KhanOrchestrator) => Promise<void>, options: KhanApiServerOptions = {}) {
  const orchestrator = new KhanOrchestrator();
  const server = createKhanApiServer(orchestrator, { auth: ApiKeyAuth.parse(KEYS), ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, orchestrator);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const as = (key: string) => ({ authorization: `Bearer ${key}` });
const json = { "content-type": "application/json" };
const ADMIN = as("secret123");
const READONLY = as("readkey456");

async function createTask(base: string, goal: string, headers: Record<string, string> = ADMIN): Promise<TaskResponse> {
  const response = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...json, ...headers }, body: JSON.stringify({ goal }) });
  assert.equal(response.status, 201);
  return (await response.json()) as TaskResponse;
}
const post = (url: string, headers: Record<string, string>, body?: unknown) =>
  fetch(url, { method: "POST", headers: { ...json, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const auditEntries = async (base: string, query = "?order=asc&limit=500") =>
  ((await (await fetch(`${base}/v1/audit${query}`, { headers: ADMIN })).json()) as AuditResponse).entries;

test("/health and /v1/status are open whatever is sent, because they must always answer", async () => {
  await withApi(async (base) => {
    for (const headers of [{}, as("wrong-key"), { authorization: "garbage" }, ADMIN]) {
      const health = await fetch(`${base}/health`, { headers });
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: "ok", service: "khan-os-api" });

      const status = await fetch(`${base}/v1/status`, { headers });
      assert.equal(status.status, 200);
      assert.equal(((await status.json()) as StatusResponse).status, "ok");
    }
  });
});

test("every other endpoint answers 401 with exactly {\"error\":\"unauthorized\"} when there is no key", async () => {
  await withApi(async (base, orchestrator) => {
    const requests: Array<[string, string, string?]> = [
      ["POST", "/v1/tasks", "{not even json"],
      ["GET", "/v1/tasks/task_x"],
      ["POST", "/v1/tasks/task_x/approve", "{}"],
      ["POST", "/v1/tasks/task_x/reject", "{}"],
      ["POST", "/v1/tasks/task_x/cancel", "{}"],
      ["GET", "/v1/tasks/task_x/events"],
      ["GET", "/v1/audit"],
      ["GET", "/v1/nope"],
      ["GET", "/v1/tasks"]
    ];
    for (const [method, path, body] of requests) {
      const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : json, body });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(await response.text(), '{"error":"unauthorized"}', `${method} ${path}`);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/, `${method} ${path}`);
    }

    const stream = await fetch(`${base}/v1/tasks/task_x/events`, { headers: { accept: "text/event-stream" } });
    assert.equal(stream.status, 401);
    assert.match(stream.headers.get("content-type") ?? "", /application\/json/, "refused with JSON, never a stream");
    assert.equal(orchestrator.diagnostics().tasks.total, 0, "nothing ran");
  });
});

test("a wrong key is refused exactly like a missing one", async () => {
  await withApi(async (base) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    const wrong: Array<[string, Record<string, string>]> = [
      ["wrong key", as("wrong")],
      ["upper-cased key", as("SECRET123")],
      ["key prefix", as("secret12")],
      ["key plus more", as("secret1234")],
      ["the name instead of the key", as("admin")],
      ["name:key", as("admin:secret123")],
      ["empty Bearer", { authorization: "Bearer " }],
      ["Basic scheme", { authorization: "Basic c2VjcmV0MTIz" }],
      ["bare key, no scheme", { authorization: "secret123" }],
      ["a different header", { "x-api-key": "secret123" }]
    ];
    for (const [label, headers] of wrong) {
      const response = await fetch(`${base}/v1/tasks/${created.task.id}`, { headers });
      assert.equal(response.status, 401, label);
      assert.equal(await response.text(), '{"error":"unauthorized"}', label);
    }
  });
});

test("the key in the URL is NOT accepted anywhere except the event stream", async () => {
  await withApi(async (base) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    for (const [method, path] of [
      ["GET", `/v1/tasks/${created.task.id}?token=secret123`],
      ["GET", "/v1/audit?token=secret123"],
      ["GET", "/v1/audit?api_key=secret123"],
      ["POST", `/v1/tasks/${created.task.id}/approve?token=secret123`],
      ["POST", "/v1/tasks?token=secret123"]
    ]) {
      const response = await fetch(`${base}${path}`, { method, headers: json, body: method === "POST" ? "{}" : undefined });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  });
});

test("valid keys reach everything, and errors keep their own status codes", async () => {
  await withApi(async (base) => {
    for (const headers of [ADMIN, READONLY]) {
      const created = await createTask(base, ANALYSIS_GOAL, headers);
      assert.equal((await fetch(`${base}/v1/tasks/${created.task.id}`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/v1/audit?limit=1`, { headers })).status, 200);
      assert.equal((await fetch(`${base}/v1/tasks/missing`, { headers })).status, 404, "a valid caller sees the real error");
      assert.equal((await post(`${base}/v1/tasks`, headers, {})).status, 400);
    }
  });
});

test("the key's name is the actor in the audit log, for creating, approving, rejecting and cancelling", async () => {
  await withApi(async (base, orchestrator) => {
    const gate = await createTask(base, GITHUB_GOAL, ADMIN);
    await orchestrator.whenSettled(gate.task.id);
    assert.equal((await post(`${base}/v1/tasks/${gate.task.id}/approve`, READONLY, { reason: "Looks fine" })).status, 202);
    await orchestrator.whenSettled(gate.task.id);

    const other = await createTask(base, GITHUB_GOAL, READONLY);
    await orchestrator.whenSettled(other.task.id);
    assert.equal((await post(`${base}/v1/tasks/${other.task.id}/reject`, ADMIN, { reason: "No" })).status, 200);

    const third = await createTask(base, GITHUB_GOAL, ADMIN);
    await orchestrator.whenSettled(third.task.id);
    assert.equal((await post(`${base}/v1/tasks/${third.task.id}/cancel`, READONLY)).status, 200);

    const refused = await post(`${base}/v1/tasks/${gate.task.id}/approve`, ADMIN, {});
    assert.equal(refused.status, 409);

    const entries = await auditEntries(base);
    const actorOf = (type: AuditEntry["type"], taskId: string, predicate: (entry: AuditEntry) => boolean = () => true) =>
      entries.find((entry) => entry.type === type && entry.taskId === taskId && predicate(entry))?.actor;

    assert.equal(actorOf("task.created", gate.task.id), "admin");
    assert.equal(actorOf("task.approved", gate.task.id), "readonly");
    assert.equal(entries.find((entry) => entry.type === "task.approved")?.data.reason, "Looks fine");
    assert.equal(actorOf("task.status_changed", gate.task.id, (entry) => entry.data.to === "executing" && entry.data.from === "waiting_approval"), "readonly");
    assert.equal(actorOf("permission.decided", gate.task.id, (entry) => entry.data.decision === "allowed" && entry.data.stepId === "implement"), "system", "the orchestrator's own decisions stay 'system'");
    assert.equal(actorOf("task.completed", gate.task.id), "system");

    assert.equal(actorOf("task.created", other.task.id), "readonly");
    assert.equal(actorOf("task.rejected", other.task.id), "admin");
    assert.equal(actorOf("task.failed", other.task.id), "admin");
    assert.equal(actorOf("task.cancelled", third.task.id), "readonly");
    assert.equal(actorOf("request.refused", gate.task.id), "admin", "even a refused attempt records who made it");

    assert.ok(!entries.some((entry) => entry.actor === "anonymous"), "with auth on, nobody is anonymous");
    const byReadonly = ((await (await fetch(`${base}/v1/audit?actor=readonly&limit=500`, { headers: ADMIN })).json()) as AuditResponse).entries;
    assert.ok(byReadonly.length >= 4);
    assert.ok(byReadonly.every((entry) => entry.actor === "readonly"));
  });
});

test("with no KHAN_API_KEYS, auth is off: everything is accepted and the actor stays anonymous", async () => {
  await withApi(
    async (base, orchestrator) => {
      const created = await createTask(base, GITHUB_GOAL, {});
      await orchestrator.whenSettled(created.task.id);
      assert.equal((await fetch(`${base}/v1/tasks/${created.task.id}`)).status, 200);
      assert.equal((await post(`${base}/v1/tasks/${created.task.id}/approve`, {}, {})).status, 202);
      assert.equal((await fetch(`${base}/v1/audit`)).status, 200);
      assert.equal((await fetch(`${base}/v1/tasks/${created.task.id}`, { headers: as("any-key-at-all") })).status, 200, "a key that is sent anyway is ignored");
      assert.equal((await fetch(`${base}/v1/tasks/${created.task.id}/events?token=ignored`)).status, 200);

      const entries = await auditEntries(base);
      assert.ok(entries.some((entry) => entry.type === "task.created" && entry.actor === "anonymous"));
      assert.ok(entries.some((entry) => entry.type === "task.approved" && entry.actor === "anonymous"));
      assert.ok(!entries.some((entry) => entry.actor === "admin"));
    },
    { auth: ApiKeyAuth.disabled() }
  );
});

test("the event stream accepts the key as ?token=, because a browser's EventSource cannot set headers", async () => {
  await withApi(async (base, orchestrator) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    await orchestrator.whenSettled(created.task.id);
    const url = `${base}/v1/tasks/${created.task.id}/events`;
    const stream = { accept: "text/event-stream" };

    const ok = await fetch(`${url}?token=secret123`, { headers: stream });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /^text\/event-stream/);
    const text = await ok.text();
    assert.match(text, /event: end/);
    assert.equal((text.match(/^data: \{"seq"/gm) ?? []).length, orchestrator.events(created.task.id).length, "the whole history was replayed");

    assert.equal((await fetch(url, { headers: stream })).status, 401, "no key");
    assert.equal((await fetch(`${url}?token=nope`, { headers: stream })).status, 401, "wrong token");
    assert.equal((await fetch(`${url}?token=`, { headers: stream })).status, 401, "empty token");
    assert.equal((await fetch(`${url}?token=secret123`, { headers: { accept: "application/json" } })).status, 200, "the JSON form takes the token too");
    assert.equal((await fetch(url, { headers: { ...stream, ...READONLY } })).status, 200, "and the header still works");
    assert.equal((await fetch(`${url}?token=readkey456`, { headers: stream })).status, 200, "any valid key");
  });
});

test("an unknown task is a 404 for a valid key but a 401 without one, so existence is not revealed", async () => {
  await withApi(async (base) => {
    assert.equal((await fetch(`${base}/v1/tasks/task_missing/events?token=secret123`, { headers: { accept: "text/event-stream" } })).status, 404);
    assert.equal((await fetch(`${base}/v1/tasks/task_missing/events`, { headers: { accept: "text/event-stream" } })).status, 401);
    assert.equal((await fetch(`${base}/v1/tasks/task_missing`)).status, 401);
  });
});

test("a real browser-style EventSource authenticates with ?token= and receives the whole run", async () => {
  await withApi(async (base, orchestrator) => {
    const created = await createTask(base, ANALYSIS_GOAL);
    const url = `${base}/v1/tasks/${created.task.id}/events`;

    const types = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = [];
      const source = new EventSource(`${url}?token=secret123`);
      source.onmessage = (message) => seen.push((JSON.parse(message.data) as { type: string }).type);
      source.addEventListener("end", () => {
        source.close();
        resolve(seen);
      });
      source.onerror = () => {
        source.close();
        reject(new Error("the stream failed (a 401 fails an EventSource for good)"));
      };
    });
    await orchestrator.whenSettled(created.task.id);

    assert.equal(types[0], "task.created");
    assert.equal(types.at(-1), "task.completed");

    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const source = new EventSource(`${url}?token=wrong`);
        source.onmessage = () => reject(new Error("a wrong token must not stream"));
        source.onerror = () => {
          source.close();
          resolve();
        };
      }).then(() => {
        throw new Error("the stream failed as expected");
      }),
      /failed as expected/
    );
  });
});

test("a preflight needs no key, and allows the Authorization header", async () => {
  await withApi(async (base) => {
    const preflight = await fetch(`${base}/v1/tasks`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" }
    });

    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

    const refused = await fetch(`${base}/v1/tasks/x`, { headers: { origin: "http://127.0.0.1:5173" } });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173", "a 401 is still readable by the page");
  });
});

test("a bad KHAN_API_KEYS stops the server from being created, and a good one turns auth on", async () => {
  const saved = process.env.KHAN_API_KEYS;
  try {
    process.env.KHAN_API_KEYS = "oops-no-colon";
    assert.throws(() => createKhanApiServer(new KhanOrchestrator()), (error: unknown) => error instanceof AuthConfigError && !/oops-no-colon/.test(error.message));

    process.env.KHAN_API_KEYS = "ops:env-key-123";
    const orchestrator = new KhanOrchestrator();
    const server = createKhanApiServer(orchestrator, {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${base}/v1/audit`)).status, 401);
      assert.equal((await fetch(`${base}/v1/audit`, { headers: as("env-key-123") })).status, 200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (saved === undefined) delete process.env.KHAN_API_KEYS;
    else process.env.KHAN_API_KEYS = saved;
  }
});

test("wrong-key attempts cost a rate limit token, so keys cannot be guessed without limit", async () => {
  await withApi(
    async (base) => {
      const remaining: Array<string | null> = [];
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`${base}/v1/audit`, { headers: as(`guess-${i}`) });
        assert.equal(response.status, 401);
        remaining.push(response.headers.get("x-ratelimit-remaining"));
      }
      assert.deepEqual(remaining, ["2", "1", "0"], "a 401 carries the rate limit headers too");

      const blocked = await fetch(`${base}/v1/audit`, { headers: ADMIN });
      assert.equal(blocked.status, 429, "even the right key is refused once the guesses have used up the client's allowance");
    },
    { rateLimits: { tasks: 0, read: 0, audit: 3 } }
  );
});

test("a key has its own limit that follows it across addresses", async () => {
  const from = (client: string) => ({ ...json, ...ADMIN, "x-test-client": client });
  await withApi(
    async (base) => {
      const create = (headers: Record<string, string>) => fetch(`${base}/v1/tasks`, { method: "POST", headers, body: JSON.stringify({ goal: ANALYSIS_GOAL }) });

      assert.equal((await create(from("a"))).status, 201);
      assert.equal((await create(from("a"))).status, 201);
      assert.equal((await create(from("a"))).status, 429, "address a is used up");

      const elsewhere = await create(from("b"));
      assert.equal(elsewhere.status, 429, "a fresh address does not help: the admin key itself is used up");
      assert.equal(elsewhere.headers.get("x-ratelimit-remaining"), "0");

      const other = await create({ ...json, ...READONLY, "x-test-client": "b" });
      assert.equal(other.status, 201, "a different key from that address is fine");
    },
    { rateLimits: { tasks: 2, read: 0, audit: 0 }, clientAddress: (req) => String(req.headers["x-test-client"]) }
  );
});

test("the rate limit headers show whichever of the client's and the key's buckets is tighter", async () => {
  await withApi(
    async (base) => {
      const create = (client: string) =>
        fetch(`${base}/v1/tasks`, { method: "POST", headers: { ...json, ...ADMIN, "x-test-client": client }, body: JSON.stringify({ goal: ANALYSIS_GOAL }) });

      const first = await create("a"); // address a: 3 left, key admin: 3 left
      const second = await create("b"); // address b: 3 left, key admin: 2 left  -> the key is tighter
      assert.deepEqual([first.headers.get("x-ratelimit-remaining"), second.headers.get("x-ratelimit-remaining")], ["3", "2"]);
    },
    { rateLimits: { tasks: 4, read: 0, audit: 0 }, clientAddress: (req) => String(req.headers["x-test-client"]) }
  );
});
