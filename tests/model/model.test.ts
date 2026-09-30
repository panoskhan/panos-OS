import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelClient, ModelConfigError, ModelError, modelConfigFromEnv, DEFAULT_MODEL, DEFAULT_MODEL_BASE_URL } from "../../services/model-router/src/client";
import { createModelCodingHandler, toFindings } from "../../agents/coding/src/model-handler";
import { collectStatus } from "../../services/status/src/index";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { RateLimiter } from "../../services/rate-limit/src/index";
import { verifyIndependentQa } from "../../agents/qa/src/index";
import { PLAN_AGENTS } from "../../agents/planner/src/index";

const KEY = "nvapi-test-key-not-real";

interface Seen {
  auth?: string;
  body?: { model: string; messages: Array<{ role: string; content: string }>; stream: boolean; max_tokens: number };
}

/** A fake OpenAI-compatible endpoint. `respond` decides the answer. */
async function fakeModel(respond: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void) {
  const seen: Seen = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      seen.auth = req.headers.authorization;
      seen.body = raw ? JSON.parse(raw) : undefined;
      respond(req, res, seen);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    seen,
    baseUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
const answer = (text: string) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }));
};
// No retries by default, so tests that expect a failure do not wait through the real backoff.
const clientFor = (baseUrl: string, timeoutMs = 5000) => new ModelClient({ apiKey: KEY, baseUrl, model: "test/model", timeoutMs }, Date.now, []);

test("no key means no model; the defaults point at NVIDIA and gemma", () => {
  assert.equal(modelConfigFromEnv({}), null);
  assert.equal(modelConfigFromEnv({ NVIDIA_API_KEY: "   " }), null);
  assert.deepEqual(modelConfigFromEnv({ NVIDIA_API_KEY: " k " }), { apiKey: "k", baseUrl: DEFAULT_MODEL_BASE_URL, model: DEFAULT_MODEL, timeoutMs: 180_000 });
  const custom = modelConfigFromEnv({ NVIDIA_API_KEY: "k", KHAN_MODEL: "m", KHAN_MODEL_BASE_URL: "http://x.test/v1/", KHAN_MODEL_TIMEOUT_MS: "1500" });
  assert.deepEqual(custom, { apiKey: "k", baseUrl: "http://x.test/v1", model: "m", timeoutMs: 1500 });
});

test("bad model settings fail loudly and never echo the key", () => {
  assert.throws(() => modelConfigFromEnv({ NVIDIA_API_KEY: "secret", KHAN_MODEL_TIMEOUT_MS: "soon" }), (error: unknown) => {
    assert.ok(error instanceof ModelConfigError);
    assert.match(error.message, /KHAN_MODEL_TIMEOUT_MS/);
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  assert.throws(() => modelConfigFromEnv({ NVIDIA_API_KEY: "k", KHAN_MODEL_BASE_URL: "not a url" }), /KHAN_MODEL_BASE_URL/);
});

test("the client sends a Bearer key and an OpenAI-style body, and returns the reply text", async () => {
  const fake = await fakeModel(answer("  hello  "));
  try {
    const client = clientFor(fake.baseUrl);
    const result = await client.chat([{ role: "user", content: "hi" }], { maxTokens: 5 });
    assert.deepEqual(result, { text: "hello", model: "test/model" });
    assert.equal(fake.seen.auth, `Bearer ${KEY}`);
    assert.equal(fake.seen.body?.model, "test/model");
    assert.equal(fake.seen.body?.stream, false);
    assert.equal(fake.seen.body?.max_tokens, 5);
    assert.deepEqual(fake.seen.body?.messages, [{ role: "user", content: "hi" }]);
  } finally {
    await fake.close();
  }
});

test("failures are typed, honest, and never contain the key", async () => {
  const cases: Array<[string, (req: IncomingMessage, res: ServerResponse) => void, string, RegExp]> = [
    ["401", (_q, res) => { res.writeHead(401); res.end('{"error":"unauthorized"}'); }, "model_http_error", /HTTP 401 \(check NVIDIA_API_KEY\)/],
    ["500", (_q, res) => { res.writeHead(500); res.end("boom"); }, "model_http_error", /HTTP 500: boom/],
    ["not json", (_q, res) => { res.writeHead(200); res.end("<html>"); }, "model_bad_response", /did not return JSON/],
    ["empty", (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: "  " } }] })); }, "model_bad_response", /no message text/]
  ];
  for (const [name, respond, code, message] of cases) {
    const fake = await fakeModel(respond);
    try {
      await assert.rejects(clientFor(fake.baseUrl).chat([{ role: "user", content: "x" }]), (error: unknown) => {
        assert.ok(error instanceof ModelError, name);
        assert.equal(error.code, code, name);
        assert.match(error.message, message, name);
        assert.ok(!error.message.includes(KEY), "the key must never appear in an error");
        return true;
      });
    } finally {
      await fake.close();
    }
  }
});

test("a briefly overloaded endpoint is retried, a permanent error is not, and running out of retries fails honestly", async () => {
  const withRetries = (baseUrl: string, delays: number[]) => new ModelClient({ apiKey: KEY, baseUrl, model: "test/model", timeoutMs: 5000 }, Date.now, delays);
  const messages = [{ role: "user" as const, content: "x" }];

  let hits = 0;
  const flaky = await fakeModel((req, res) => (++hits < 3 ? (res.writeHead(503), res.end("overloaded")) : answer("finally")(req, res)));
  try {
    assert.equal((await withRetries(flaky.baseUrl, [1, 1]).chat(messages)).text, "finally");
    assert.equal(hits, 3, "two temporary failures, then success");
  } finally {
    await flaky.close();
  }

  hits = 0;
  const forbidden = await fakeModel((_q, res) => (hits++, res.writeHead(401), res.end("no")));
  try {
    await assert.rejects(withRetries(forbidden.baseUrl, [1, 1]).chat(messages), /HTTP 401/);
    assert.equal(hits, 1, "a wrong key is not retried");
  } finally {
    await forbidden.close();
  }

  hits = 0;
  const down = await fakeModel((_q, res) => (hits++, res.writeHead(503), res.end("overloaded")));
  try {
    const client = withRetries(down.baseUrl, [1, 1]);
    await assert.rejects(client.chat(messages), /HTTP 503/);
    assert.equal(hits, 3, "the first try and two retries");
    assert.deepEqual([client.health().calls, client.health().failures], [1, 1], "one chat call is one call, however many tries it took");
  } finally {
    await down.close();
  }
});

test("an unreachable endpoint and a slow one are reported as such", async () => {
  const fake = await fakeModel(() => {
    /* never answers */
  });
  try {
    await assert.rejects(clientFor(fake.baseUrl, 150).chat([{ role: "user", content: "x" }]), (error: unknown) => {
      assert.ok(error instanceof ModelError);
      assert.equal(error.code, "model_timeout");
      assert.match(error.message, /within 150ms/);
      return true;
    });
  } finally {
    await fake.close();
  }
  await assert.rejects(clientFor("http://127.0.0.1:1/v1").chat([{ role: "user", content: "x" }]), (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, "model_unreachable");
    return true;
  });
});

test("health counts real calls and remembers the last failure", async () => {
  let fail = false;
  const fake = await fakeModel((req, res, seen) => (fail ? (res.writeHead(503), res.end("down")) : answer("ok")(req, res)));
  try {
    const client = clientFor(fake.baseUrl);
    assert.deepEqual(client.health(), { configured: true, model: "test/model", calls: 0, failures: 0, lastSuccessAt: undefined, lastFailure: undefined });
    await client.chat([{ role: "user", content: "x" }]);
    fail = true;
    await assert.rejects(client.chat([{ role: "user", content: "x" }]));
    const health = client.health();
    assert.equal(health.calls, 2);
    assert.equal(health.failures, 1);
    assert.ok(health.lastSuccessAt);
    assert.match(health.lastFailure!.message, /HTTP 503/);
  } finally {
    await fake.close();
  }
});

test("model answers become short findings", () => {
  assert.deepEqual(toFindings("- one\n\n* two\n3. three\n  4) four  \nplain"), ["one", "two", "three", "four", "plain"]);
  assert.equal(toFindings(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n")).length, 8);
  assert.equal(toFindings("x".repeat(1000))[0].length, 401);
});

test("the model coding agent asks the model, states it changed nothing, and still names the goal for QA", async () => {
  const fake = await fakeModel(answer("- Read the auth module\n- Add a failing test\n- Fix the check"));
  try {
    const handler = createModelCodingHandler(clientFor(fake.baseUrl));
    const step = { id: "implement", title: "Implement the fix", agent: "coding" as const, permissions: ["workspace.read"], dependsOn: [] };
    const result = await handler(step, { taskId: "t", projectId: "p", goal: "Fix the login bug", inputs: { agentResults: [{ status: "success", summary: "Inspected" }] } });

    assert.equal(result.status, "success");
    assert.match(result.summary, /Fix the login bug/);
    assert.match(result.findings![0], /no files were changed and no tests were run/);
    assert.deepEqual(result.findings!.slice(1), ["Read the auth module", "Add a failing test", "Fix the check"]);
    const prompt = fake.seen.body!.messages.map((message) => message.content).join("\n");
    assert.match(prompt, /Goal: Fix the login bug/);
    assert.match(prompt, /Current step \(implement\)/);
    assert.match(prompt, /- Inspected/);
    assert.equal(verifyIndependentQa([result], "Fix the login bug").passed, true);
  } finally {
    await fake.close();
  }
});

test("a full task runs on the model, and a model outage fails the task instead of faking success", async () => {
  const good = await fakeModel(answer("- finding one\n- finding two"));
  try {
    const orchestrator = new KhanOrchestrator(undefined, undefined, createModelCodingHandler(clientFor(good.baseUrl)));
    const report = await orchestrator.run("Analyze the repository");
    assert.equal(report.task.status, "completed");
    assert.ok(report.execution.some((entry) => entry.output?.findings?.includes("finding one")));
  } finally {
    await good.close();
  }

  const bad = await fakeModel((_q, res) => (res.writeHead(500), res.end("nope")));
  try {
    const orchestrator = new KhanOrchestrator(undefined, undefined, createModelCodingHandler(clientFor(bad.baseUrl)));
    const report = await orchestrator.run("Analyze the repository");
    assert.equal(report.task.status, "failed");
    assert.match(JSON.stringify(report.execution), /HTTP 500/);
  } finally {
    await bad.close();
  }
});

test("the Model Router status: none, unverified, up, and down", async () => {
  const fake = await fakeModel(answer("ok"));
  const orchestrator = new KhanOrchestrator();
  const statusOf = (model?: ModelClient) => {
    const status = collectStatus({
      service: "s",
      version: "v",
      startedAt: 0,
      now: () => 1000,
      diagnostics: () => orchestrator.diagnostics(),
      planAgents: PLAN_AGENTS,
      verify: verifyIndependentQa,
      rateLimiter: new RateLimiter({ tasks: 1, read: 1, audit: 1 }),
      model
    });
    return status.components.find((component) => component.id === "model-router")!;
  };
  try {
    assert.equal(statusOf().state, "not_configured");
    assert.match(statusOf().detail, /NVIDIA_API_KEY/);

    const client = clientFor(fake.baseUrl);
    assert.equal(statusOf(client).state, "not_configured", "a key alone proves nothing");
    assert.match(statusOf(client).detail, /unverified/);

    await client.chat([{ role: "user", content: "x" }]);
    const up = statusOf(client);
    assert.equal(up.state, "up");
    assert.deepEqual(up.metrics, { calls: 1, failures: 0 });
  } finally {
    await fake.close();
  }
  // The endpoint is gone now: the next real call fails and the light turns red.
  const dead = clientFor("http://127.0.0.1:1/v1");
  await assert.rejects(dead.chat([{ role: "user", content: "x" }]));
  const down = statusOf(dead);
  assert.equal(down.state, "down");
  assert.match(down.detail, /last call failed/);
});
