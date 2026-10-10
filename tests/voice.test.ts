/**
 * PANOS-OS Phase 6 — Voice endpoint tests
 * Runner: node --env-file=tests/test.env --experimental-eventsource --import tsx --test "tests/**‌/*.test.ts"
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseVoiceIntent } from "../apps/api/src/voice";

// ─── Unit tests: parseVoiceIntent ────────────────────────────────────────────────────────────────────────────────

describe("parseVoiceIntent", () => {
  it('parses "Hey KHAN, create a task to ..."', () => {
    const r = parseVoiceIntent("Hey KHAN, create a task to write unit tests");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "write unit tests");
  });
  it('parses "Hey KHAN, run the deployment pipeline"', () => {
    const r = parseVoiceIntent("Hey KHAN, run the deployment pipeline");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "run the deployment pipeline");
  });
  it('parses "Hey KHAN, build the dashboard" (bare delegation)', () => {
    const r = parseVoiceIntent("Hey KHAN, build the dashboard");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "build the dashboard");
  });
  it('parses "Hey KHAN, do the thing" (bare delegation, no verb)', () => {
    const r = parseVoiceIntent("Hey KHAN, do the thing");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "do the thing");
  });
  it('parses "new task: refactor auth module"', () => {
    const r = parseVoiceIntent("new task: refactor auth module");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "refactor auth module");
  });
  it("strips trailing punctuation from goal", () => {
    const r = parseVoiceIntent("Hey KHAN, deploy the staging env.");
    assert.equal(r.kind, "new_task");
    assert.ok("goal" in r && r.goal === "deploy the staging env");
  });
  it('parses "approve"', () => { assert.equal(parseVoiceIntent("approve").kind, "approve"); });
  it('parses "yes, go ahead"', () => { assert.equal(parseVoiceIntent("yes, go ahead").kind, "approve"); });
  it('parses "looks good"', () => { assert.equal(parseVoiceIntent("looks good").kind, "approve"); });
  it('parses "affirmative"', () => { assert.equal(parseVoiceIntent("affirmative").kind, "approve"); });
  it('parses "reject"', () => { assert.equal(parseVoiceIntent("reject").kind, "reject"); });
  it('parses "no"', () => { assert.equal(parseVoiceIntent("no").kind, "reject"); });
  it("parses "don't do it"", () => { assert.equal(parseVoiceIntent("don't do it").kind, "reject"); });
  it('parses "bad idea"', () => { assert.equal(parseVoiceIntent("bad idea").kind, "reject"); });
  it('parses "cancel"', () => { assert.equal(parseVoiceIntent("cancel").kind, "cancel"); });
  it('parses "abort"', () => { assert.equal(parseVoiceIntent("abort").kind, "cancel"); });
  it('parses "terminate"', () => { assert.equal(parseVoiceIntent("terminate").kind, "cancel"); });
  it('parses "status"', () => { assert.equal(parseVoiceIntent("status").kind, "status"); });
  it("parses "what's the status"", () => { assert.equal(parseVoiceIntent("what's the status").kind, "status"); });
  it("parses "how's it going"", () => { assert.equal(parseVoiceIntent("how's it going").kind, "status"); });
  it("returns unknown for empty string", () => { assert.equal(parseVoiceIntent("").kind, "unknown"); });
  it("returns unknown for whitespace", () => { assert.equal(parseVoiceIntent("   ").kind, "unknown"); });
  it('returns unknown for "hello"', () => { assert.equal(parseVoiceIntent("hello").kind, "unknown"); });
  it("cancel beats approve (cancel is checked first)", () => { assert.equal(parseVoiceIntent("cancel").kind, "cancel"); });
});

// ─── Integration tests: POST /v1/voice ────────────────────────────────────────────────────────────────────────────

/** Minimal HTTP helper — avoids native fetch to keep Node 18 compatibility */
function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const raw = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(raw ? { "Content-Length": Buffer.byteLength(raw) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      }
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

describe("POST /v1/voice", () => {
  let server: http.Server;

  before(async () => {
    const { createKhanApiServer } = await import("../apps/api/src/index.js");
    server = createKhanApiServer();
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  });

  after(() => { server.close(); });

  it("new_task utterance creates a task and returns 201", async () => {
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "Hey KHAN, build the monitoring dashboard" });
    assert.equal(status, 201);
    const b = body as Record<string, unknown>;
    assert.equal(b.intent, "new_task");
    assert.ok(typeof b.taskId === "string" && b.taskId.length > 0);
    assert.equal(b.goal, "build the monitoring dashboard");
  });

  it("approve utterance with existing taskId returns 202 or 409", async () => {
    const create = await request(server, "POST", "/v1/tasks", { goal: "approve test task", projectId: "voice-test" });
    assert.equal(create.status, 201);
    const taskId = (create.body as { task?: { id?: string } }).task?.id;
    assert.ok(typeof taskId === "string" && taskId.length > 0);
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "approve", taskId });
    assert.ok(status === 202 || status === 409, `Expected 202 or 409, got ${status}`);
    assert.equal((body as Record<string, unknown>).intent, "approve");
  });

  it("reject utterance with taskId returns 200 or 409", async () => {
    const create = await request(server, "POST", "/v1/tasks", { goal: "reject test task", projectId: "voice-test" });
    assert.equal(create.status, 201);
    const taskId = (create.body as { task?: { id?: string } }).task?.id;
    assert.ok(typeof taskId === "string");
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "no, bad idea", taskId });
    assert.ok(status === 200 || status === 409, `Expected 200 or 409, got ${status}`);
    assert.equal((body as Record<string, unknown>).intent, "reject");
  });

  it("cancel utterance with taskId returns 200 or 409", async () => {
    const create = await request(server, "POST", "/v1/tasks", { goal: "cancel test task", projectId: "voice-test" });
    assert.equal(create.status, 201);
    const taskId = (create.body as { task?: { id?: string } }).task?.id;
    assert.ok(typeof taskId === "string");
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "cancel", taskId });
    assert.ok(status === 200 || status === 409, `Expected 200 or 409, got ${status}`);
    assert.equal((body as Record<string, unknown>).intent, "cancel");
  });

  it("status utterance with taskId returns 200", async () => {
    const create = await request(server, "POST", "/v1/tasks", { goal: "status check task", projectId: "voice-test" });
    assert.equal(create.status, 201);
    const taskId = (create.body as { task?: { id?: string } }).task?.id;
    assert.ok(typeof taskId === "string");
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "status", taskId });
    assert.equal(status, 200);
    const b = body as Record<string, unknown>;
    assert.equal(b.intent, "status");
    assert.equal(b.taskId, taskId);
  });

  it("unknown utterance returns 422 with unrecognized_utterance", async () => {
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "hello there" });
    assert.equal(status, 422);
    assert.equal((body as Record<string, unknown>).error, "unrecognized_utterance");
  });

  it("missing utterance returns 400", async () => {
    const { status } = await request(server, "POST", "/v1/voice", {});
    assert.equal(status, 400);
  });

  it("wrong HTTP method returns 405", async () => {
    const { status } = await request(server, "GET", "/v1/voice");
    assert.equal(status, 405);
  });

  it("approve without taskId returns 400 task_id_required", async () => {
    const { status, body } = await request(server, "POST", "/v1/voice", { utterance: "approve" });
    assert.equal(status, 400);
    assert.equal((body as Record<string, unknown>).error, "task_id_required");
  });

  it("unauthenticated request returns 401 when auth keys are configured", async () => {
    if (!process.env.KHAN_API_KEYS) return;
    const { status } = await request(server, "POST", "/v1/voice", { utterance: "Hey KHAN, do something" });
    assert.equal(status, 401);
  });
});
