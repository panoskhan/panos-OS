import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createKhanApiServer, type KhanApiServerOptions } from "../../apps/api/src/index";
import type { StatusResponse } from "../../packages/contracts/src/api";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import type { RateLimitConfig } from "../../services/rate-limit/src/index";

const START = 1_700_000_000_000;
const GOAL = "Analyze this project and identify the next engineering tasks.";

async function withApi(
  fn: (base: string, clock: { now: number }, orchestrator: KhanOrchestrator) => Promise<void>,
  options: KhanApiServerOptions = {}
) {
  const clock = { now: START };
  const orchestrator = new KhanOrchestrator();
  const server = createKhanApiServer(orchestrator, { clock: () => clock.now, ...options });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, clock, orchestrator);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const limits = (overrides: Partial<RateLimitConfig>): { rateLimits: RateLimitConfig } => ({
  rateLimits: { tasks: 0, read: 0, audit: 0, ...overrides }
});
const createTask = (base: string) =>
  fetch(`${base}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goal: GOAL }) });
const rateHeaders = (response: Response) => ({
  limit: response.headers.get("x-ratelimit-limit"),
  remaining: response.headers.get("x-ratelimit-remaining"),
  reset: response.headers.get("x-ratelimit-reset"),
  retryAfter: response.headers.get("retry-after")
});

test("the 11th task in a minute is refused with a 429, a Retry-After and the JSON body, and the task is not created", async () => {
  await withApi(
    async (base, clock, orchestrator) => {
      const ok: number[] = [];
      for (let i = 0; i < 10; i++) ok.push((await createTask(base)).status);
      assert.deepEqual(ok, Array(10).fill(201));

      const refused = await createTask(base);

      assert.equal(refused.status, 429);
      assert.match(refused.headers.get("content-type") ?? "", /application\/json/);
      assert.deepEqual(await refused.json(), { error: "rate_limited", retryAfterMs: 6000 }, "10 per minute is one token every 6 seconds");
      assert.equal(refused.headers.get("retry-after"), "6");
      assert.equal(orchestrator.diagnostics().tasks.total, 10, "the refused request created nothing");

      clock.now += 5_999;
      assert.equal((await createTask(base)).status, 429, "still early");
      clock.now += 1;
      assert.equal((await createTask(base)).status, 201, "one token is back after the wait");
    },
    limits({ tasks: 10 })
  );
});

test("Retry-After is whole seconds rounded up, and retryAfterMs is exact", async () => {
  await withApi(
    async (base) => {
      await createTask(base);
      await createTask(base);
      const refused = await createTask(base); // 2 per minute: a token every 30 s

      assert.equal(refused.headers.get("retry-after"), "30");
      assert.equal(((await refused.json()) as { retryAfterMs: number }).retryAfterMs, 30_000);
    },
    limits({ tasks: 2 })
  );
  await withApi(
    async (base) => {
      for (let i = 0; i < 7; i++) assert.equal((await createTask(base)).status, 201);
      const refused = await createTask(base); // 7 per minute: a token every 8571.4 ms
      const body = (await refused.json()) as { retryAfterMs: number };

      assert.equal(body.retryAfterMs, 8572);
      assert.equal(refused.headers.get("retry-after"), "9");
    },
    limits({ tasks: 7 })
  );
});

test("every response carries X-RateLimit-Limit, -Remaining and -Reset, and they count down", async () => {
  await withApi(
    async (base, clock) => {
      const first = await createTask(base);
      const second = await createTask(base);
      const third = await createTask(base);
      const refused = await createTask(base);

      assert.deepEqual(rateHeaders(first), { limit: "3", remaining: "2", reset: String(Math.ceil((START + 20_000) / 1000)), retryAfter: null });
      assert.equal(rateHeaders(second).remaining, "1");
      assert.equal(rateHeaders(third).remaining, "0");
      assert.equal(rateHeaders(third).reset, String(Math.ceil((START + 60_000) / 1000)), "reset is when the bucket is full again (Unix seconds)");
      assert.deepEqual(rateHeaders(refused), { limit: "3", remaining: "0", reset: String(Math.ceil((START + 60_000) / 1000)), retryAfter: "20" });

      clock.now += 20_000;
      assert.equal(rateHeaders(await createTask(base)).remaining, "0", "refilled one token and spent it");
    },
    limits({ tasks: 3 })
  );
});

test("the headers are on error responses and on event streams too, not only on successes", async () => {
  await withApi(
    async (base) => {
      const notFound = await fetch(`${base}/v1/tasks/missing`);
      const badBody = await fetch(`${base}/v1/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
      const noRoute = await fetch(`${base}/v1/nope`);
      const wrongMethod = await fetch(`${base}/v1/status`, { method: "POST" });

      assert.equal(notFound.status, 404);
      assert.equal(badBody.status, 400);
      assert.equal(noRoute.status, 404);
      assert.equal(wrongMethod.status, 405);
      for (const response of [notFound, noRoute, wrongMethod]) assert.equal(rateHeaders(response).limit, "50", `${response.url} (read class)`);
      assert.equal(rateHeaders(badBody).limit, "5", "task creation is its own class");
      assert.deepEqual([rateHeaders(notFound).remaining, rateHeaders(noRoute).remaining, rateHeaders(wrongMethod).remaining], ["49", "48", "47"]);

      const created = (await (await createTask(base)).json()) as { task: { id: string } };
      const stream = await fetch(`${base}/v1/tasks/${created.task.id}/events`, { headers: { accept: "text/event-stream" } });
      assert.equal(stream.headers.get("content-type")?.startsWith("text/event-stream"), true);
      assert.equal(rateHeaders(stream).limit, "50");
      await stream.body?.cancel();
    },
    limits({ tasks: 5, read: 50 })
  );
});

test("reads, audit reads and task creation each have their own bucket", async () => {
  await withApi(
    async (base) => {
      // Use up the task bucket (1) and the audit bucket (1).
      assert.equal((await createTask(base)).status, 201);
      assert.equal((await createTask(base)).status, 429, "task creation is used up");
      assert.equal((await fetch(`${base}/v1/audit`)).status, 200);
      const auditRefused = await fetch(`${base}/v1/audit`);
      assert.equal(auditRefused.status, 429, "the audit bucket is used up");
      assert.equal(rateHeaders(auditRefused).limit, "1");

      // The read bucket (2) is untouched by all of that: it still allows exactly two requests.
      const first = await fetch(`${base}/health`);
      assert.equal(first.status, 200);
      assert.equal(rateHeaders(first).remaining, "1");
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/health`)).status, 429, "and then the read bucket is used up too");
    },
    limits({ tasks: 1, read: 2, audit: 1 })
  );
});

test("the audit endpoint is limited at its own, lower number", async () => {
  await withApi(
    async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await fetch(`${base}/v1/audit`)).status);

      assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
      assert.equal(statuses[20], 429, "the 21st audit read in a minute");
      assert.equal((await fetch(`${base}/health`)).status, 200, "other endpoints are unaffected");
    },
    limits({ audit: 20 })
  );
});

test("every other request counts against the read limit: reads, decisions, the stream, the status endpoints, unknown paths", async () => {
  await withApi(
    async (base) => {
      const paths: Array<[string, string]> = [
        ["GET", "/health"],
        ["GET", "/v1/status"],
        ["GET", "/v1/tasks/task_none"],
        ["POST", "/v1/tasks/task_none/approve"],
        ["GET", "/no/such/path"]
      ];
      const statuses: number[] = [];
      for (const [method, path] of paths) statuses.push((await fetch(`${base}${path}`, { method })).status);
      assert.deepEqual(statuses, [200, 200, 404, 404, 404]);

      const sixth = await fetch(`${base}/health`);
      assert.equal(sixth.status, 429, "five requests of five different kinds used up a read limit of five");
      assert.equal(rateHeaders(sixth).limit, "5");
    },
    limits({ read: 5 })
  );
});

test("a preflight request is never counted", async () => {
  await withApi(
    async (base) => {
      for (let i = 0; i < 20; i++) {
        const preflight = await fetch(`${base}/v1/tasks`, {
          method: "OPTIONS",
          headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "POST" }
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get("x-ratelimit-limit"), null);
      }
      const first = await fetch(`${base}/health`);
      assert.equal(rateHeaders(first).remaining, "1", "the limit of 2 is untouched by 20 preflights");
    },
    limits({ read: 2 })
  );
});

test("browser pages can read the rate limit headers, including on a 429", async () => {
  await withApi(
    async (base) => {
      const origin = "http://127.0.0.1:5173";
      const allowed = await fetch(`${base}/health`, { headers: { origin } });
      const refused = await fetch(`${base}/health`, { headers: { origin } });

      assert.equal(refused.status, 429);
      for (const response of [allowed, refused]) {
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        const exposed = response.headers.get("access-control-expose-headers") ?? "";
        for (const header of ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) assert.ok(exposed.includes(header), `${header} is exposed`);
      }
    },
    limits({ read: 1 })
  );
});

test("with every limit at 0 nothing is limited and no rate limit headers are sent", async () => {
  await withApi(
    async (base) => {
      const statuses = new Set<number>();
      let headerSeen = false;
      for (let i = 0; i < 100; i++) {
        const response = await fetch(`${base}/health`);
        statuses.add(response.status);
        headerSeen ||= response.headers.has("x-ratelimit-limit");
      }
      for (let i = 0; i < 25; i++) statuses.add((await createTask(base)).status);

      assert.deepEqual([...statuses].sort(), [200, 201]);
      assert.equal(headerSeen, false);
    },
    limits({})
  );
});

test("tests run with rate limiting off by default, because tests/test.env sets every limit to 0", async () => {
  assert.equal(process.env.KHAN_RATE_LIMIT_TASKS, "0");
  assert.equal(process.env.KHAN_RATE_LIMIT_READ, "0");
  assert.equal(process.env.KHAN_RATE_LIMIT_AUDIT, "0");

  await withApi(async (base) => {
    const statuses = new Set<number>();
    for (let i = 0; i < 25; i++) statuses.add((await createTask(base)).status); // the built-in limit would refuse the 11th
    assert.deepEqual([...statuses], [201]);
  });
});

test("the limits are read from KHAN_RATE_LIMIT_* when the server is created", async () => {
  const saved = { ...process.env };
  process.env.KHAN_RATE_LIMIT_TASKS = "2";
  process.env.KHAN_RATE_LIMIT_READ = "0";
  process.env.KHAN_RATE_LIMIT_AUDIT = "0";
  try {
    await withApi(async (base) => {
      assert.equal((await createTask(base)).status, 201);
      assert.equal((await createTask(base)).status, 201);
      assert.equal((await createTask(base)).status, 429);
      assert.equal((await fetch(`${base}/health`)).headers.get("x-ratelimit-limit"), null, "READ=0 turned that limit off");
    });

    process.env.KHAN_RATE_LIMIT_READ = "lots";
    assert.throws(() => createKhanApiServer(new KhanOrchestrator()), /KHAN_RATE_LIMIT_READ must be a whole number/);
  } finally {
    process.env.KHAN_RATE_LIMIT_TASKS = saved.KHAN_RATE_LIMIT_TASKS;
    process.env.KHAN_RATE_LIMIT_READ = saved.KHAN_RATE_LIMIT_READ;
    process.env.KHAN_RATE_LIMIT_AUDIT = saved.KHAN_RATE_LIMIT_AUDIT;
  }
});

test("/v1/status shows the rate limiter's configuration and how many requests it has refused", async () => {
  await withApi(
    async (base) => {
      await createTask(base);
      await createTask(base); // refused

      const status = (await (await fetch(`${base}/v1/status`)).json()) as StatusResponse;
      const component = status.components.find((entry) => entry.id === "rate-limiter")!;

      assert.equal(component.name, "Rate Limiter");
      assert.equal(component.state, "up");
      assert.deepEqual(component.metrics, { tasksPerMinute: 1, readPerMinute: 100, auditPerMinute: 0, tracked: 2, limitedTotal: 1 });
      assert.equal(component.detail, "Per client: task creation 1/min, other requests 100/min, audit reads off. 2 client buckets tracked, 1 request refused so far.");
      assert.equal(status.status, "ok");
    },
    limits({ tasks: 1, read: 100 })
  );
});
