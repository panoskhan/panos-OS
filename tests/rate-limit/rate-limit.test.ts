import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RATE_LIMITS, RateLimiter, classify, rateLimitsFromEnv, type RateDecision } from "../../services/rate-limit/src/index";

const START = 1_700_000_000_000;

function limiterAt(limits: { tasks?: number; read?: number; audit?: number }) {
  const clock = { now: START };
  const limiter = new RateLimiter({ tasks: 0, read: 0, audit: 0, ...limits }, () => clock.now);
  return { clock, limiter };
}
const must = (decision: RateDecision | null): RateDecision => {
  assert.ok(decision, "expected the class to be limited");
  return decision;
};

test("a bucket starts full, spends one token per request, then refuses with the wait until the next one", () => {
  const { limiter } = limiterAt({ tasks: 3 }); // 3 per minute: one token every 20 seconds

  const results = [1, 2, 3, 4].map(() => must(limiter.check("tasks", "ip:1")));

  assert.deepEqual(results.map((r) => [r.limited, r.remaining]), [[false, 2], [false, 1], [false, 0], [true, 0]]);
  assert.ok(results.every((r) => r.limit === 3));
  assert.equal(results[3].retryAfterMs, 20_000);
  assert.equal(results[0].retryAfterMs, 0, "an allowed request has nothing to wait for");
});

test("tokens come back over time, and the reset time is when the bucket is full again", () => {
  const { clock, limiter } = limiterAt({ tasks: 3 });
  for (let i = 0; i < 3; i++) limiter.check("tasks", "ip:1");

  assert.equal(must(limiter.check("tasks", "ip:1")).limited, true);
  assert.equal(must(limiter.check("tasks", "ip:1")).retryAfterMs, 20_000);

  clock.now += 19_999;
  assert.equal(must(limiter.check("tasks", "ip:1")).limited, true, "one millisecond early");
  clock.now += 1;
  const back = must(limiter.check("tasks", "ip:1"));
  assert.deepEqual([back.limited, back.remaining], [false, 0]);
  assert.equal(back.resetAtMs, clock.now + 60_000, "an empty bucket takes a full minute to fill");

  clock.now += 20_000;
  const next = must(limiter.check("tasks", "ip:1"));
  assert.equal(next.remaining, 0);
  clock.now += 3 * 60_000;
  assert.equal(must(limiter.check("tasks", "ip:1")).remaining, 2, "idle time refills only up to the limit, never beyond");
});

test("each client and each class has its own bucket", () => {
  const { limiter } = limiterAt({ tasks: 1, read: 1, audit: 1 });

  assert.equal(must(limiter.check("tasks", "ip:1")).limited, false);
  assert.equal(must(limiter.check("tasks", "ip:1")).limited, true);
  assert.equal(must(limiter.check("tasks", "ip:2")).limited, false, "another client is unaffected");
  assert.equal(must(limiter.check("tasks", "key:admin")).limited, false, "a key is its own client");
  assert.equal(must(limiter.check("read", "ip:1")).limited, false, "another class is unaffected");
  assert.equal(must(limiter.check("audit", "ip:1")).limited, false);
});

test("a class set to 0 is not limited at all", () => {
  const { limiter } = limiterAt({ tasks: 2, read: 0 });

  for (let i = 0; i < 1000; i++) assert.equal(limiter.check("read", "ip:1"), null);
  assert.equal(limiter.describe().tracked, 0, "nothing is tracked for a disabled class");
});

test("the description reports the limits, the buckets tracked and the requests refused", () => {
  const { limiter } = limiterAt({ tasks: 1, read: 5 });
  limiter.check("tasks", "ip:1");
  limiter.check("tasks", "ip:1");
  limiter.check("tasks", "ip:1");
  limiter.check("read", "ip:2");

  assert.deepEqual(limiter.describe(), { limits: { tasks: 1, read: 5, audit: 0 }, tracked: 2, limitedTotal: 2 });
});

test("clients that have fully refilled are forgotten, so the table cannot grow without bound", () => {
  const { clock, limiter } = limiterAt({ read: 60 });
  for (let i = 0; i < 700; i++) limiter.check("read", `ip:${i}`);
  assert.equal(limiter.describe().tracked, 700);

  clock.now += 120_000; // every one of them has refilled
  for (let i = 0; i < 300; i++) limiter.check("read", "ip:busy"); // the 1000th check triggers a sweep

  assert.ok(limiter.describe().tracked <= 2, `${limiter.describe().tracked} buckets kept`);
});

test("the request that triggers a sweep is still counted against its own client", () => {
  const { limiter } = limiterAt({ tasks: 2 });
  for (let i = 0; i < 499; i++) limiter.check("tasks", `ip:filler-${i}`);

  // This is the 500th check, which sweeps. The client's first request must still spend a token.
  assert.equal(must(limiter.check("tasks", "ip:target")).remaining, 1);
  assert.equal(must(limiter.check("tasks", "ip:target")).remaining, 0);
  assert.equal(must(limiter.check("tasks", "ip:target")).limited, true, "two requests used up the two tokens");
});

test("a client still short of tokens is not forgotten by the sweep", () => {
  const { clock, limiter } = limiterAt({ tasks: 2 });
  limiter.check("tasks", "ip:slow");
  limiter.check("tasks", "ip:slow");
  clock.now += 1_000; // far from full
  for (let i = 0; i < 500; i++) limiter.check("tasks", `ip:other-${i % 3}`);

  assert.equal(must(limiter.check("tasks", "ip:slow")).limited, true, "its empty bucket survived the sweep");
});

test("requests are classified: task creation, audit reads, and everything else", () => {
  assert.equal(classify("POST", "/v1/tasks"), "tasks");
  assert.equal(classify("GET", "/v1/audit"), "audit");
  assert.equal(classify("POST", "/v1/audit"), "audit");
  for (const [method, path] of [
    ["GET", "/v1/tasks/task_1"],
    ["GET", "/v1/tasks/task_1/events"],
    ["POST", "/v1/tasks/task_1/approve"],
    ["POST", "/v1/tasks/task_1/reject"],
    ["POST", "/v1/tasks/task_1/cancel"],
    ["GET", "/v1/tasks"],
    ["GET", "/v1/status"],
    ["GET", "/health"],
    ["GET", "/nope"]
  ]) {
    assert.equal(classify(method, path), "read", `${method} ${path}`);
  }
});

test("limits are read from the environment, and 0 turns one off", () => {
  assert.deepEqual(rateLimitsFromEnv({}), DEFAULT_RATE_LIMITS);
  assert.deepEqual(DEFAULT_RATE_LIMITS, { tasks: 10, read: 60, audit: 20 });
  assert.deepEqual(rateLimitsFromEnv({ KHAN_RATE_LIMIT_TASKS: "3", KHAN_RATE_LIMIT_READ: "0", KHAN_RATE_LIMIT_AUDIT: " 7 " }), { tasks: 3, read: 0, audit: 7 });
  assert.deepEqual(rateLimitsFromEnv({ KHAN_RATE_LIMIT_TASKS: "", KHAN_RATE_LIMIT_READ: "  " }), DEFAULT_RATE_LIMITS, "blank means unset");
  assert.deepEqual(rateLimitsFromEnv({ KHAN_RATE_LIMIT_TASKS: "0", KHAN_RATE_LIMIT_READ: "0", KHAN_RATE_LIMIT_AUDIT: "0" }), { tasks: 0, read: 0, audit: 0 });
});

test("a bad limit in the environment fails loudly and names the variable", () => {
  for (const [name, value] of [
    ["KHAN_RATE_LIMIT_TASKS", "ten"],
    ["KHAN_RATE_LIMIT_READ", "-1"],
    ["KHAN_RATE_LIMIT_AUDIT", "1.5"],
    ["KHAN_RATE_LIMIT_TASKS", "10 per minute"]
  ]) {
    assert.throws(() => rateLimitsFromEnv({ [name]: value }), new RegExp(`${name} must be a whole number of requests per minute .* got '${value}'`), `${name}=${value}`);
  }
});

test("the self-test passes on a working limiter and fails on one that does not limit", () => {
  assert.deepEqual(new RateLimiter(DEFAULT_RATE_LIMITS).selfTest(), []);

  class NeverLimits extends RateLimiter {
    override check() {
      return { limited: false, limit: 2, remaining: 1, resetAtMs: 0, retryAfterMs: 0 };
    }
  }
  const problems = new NeverLimits(DEFAULT_RATE_LIMITS).selfTest();
  assert.ok(problems.length > 0);
  assert.ok(problems.some((problem) => /over the limit was not refused/.test(problem)));
});
