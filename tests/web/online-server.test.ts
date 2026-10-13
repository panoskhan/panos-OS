import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOnlineServer } from "../../apps/web/src/online-server";

test("online host protects the app and API, serves assets, and completes a task on the same origin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panos-online-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Panos OS</title>");
  writeFileSync(join(dir, "app.js"), "console.log('Panos OS')");
  const previous = process.env.KHAN_AUDIT_FILE;
  process.env.KHAN_AUDIT_FILE = join(dir, "audit.jsonl");
  const password = "test-only-password-12345";
  const server = createOnlineServer(password, dir);
  if (previous === undefined) delete process.env.KHAN_AUDIT_FILE;
  else process.env.KHAN_AUDIT_FILE = previous;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`panos:${password}`).toString("base64")}` };
  try {
    assert.throws(() => createOnlineServer("short", dir), /SITE_PASSWORD/);
    for (const path of ["/", "/app.js", "/v1/status", "/v1/tasks"])
      assert.equal((await fetch(base + path)).status, 401);
    assert.equal((await fetch(base + "/", { headers: { Authorization: "Basic invalid" } })).status, 401);
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.match(await (await fetch(base + "/", { headers })).text(), /Panos OS/);
    assert.match((await fetch(base + "/app.js", { headers })).headers.get("content-type")!, /javascript/);
    assert.equal((await fetch(base + "/missing.js", { headers })).status, 404);
    assert.equal((await fetch(base + "/v1/status", { headers })).status, 200);
    const payload = JSON.stringify({ goal: "Analyze this project and identify engineering tasks." });
    const crossOrigin = await fetch(base + "/v1/tasks", { method: "POST", headers: { ...headers, Origin: "https://other.example", "Content-Type": "application/json" }, body: payload });
    assert.equal(crossOrigin.status, 403);
    const created = await fetch(base + "/v1/tasks", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: payload });
    assert.equal(created.status, 201);
    const { task } = await created.json() as { task: { id: string } };
    let complete = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const report = await (await fetch(base + `/v1/tasks/${task.id}`, { headers })).json() as { task: { status: string }; verification: { passed: boolean } };
      if (report.task.status === "completed") { assert.equal(report.verification.passed, true); complete = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(complete, true);
    const events = await fetch(base + `/v1/tasks/${task.id}/events`, { headers: { ...headers, Accept: "text/event-stream" } });
    assert.match(events.headers.get("content-type")!, /text\/event-stream/);
    assert.match(await events.text(), /event: end/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public demo opens without credentials but blocks settings, automation and approvals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panos-demo-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Public demo</title>");
  const previous = process.env.KHAN_AUDIT_FILE;
  process.env.KHAN_AUDIT_FILE = join(dir, "audit.jsonl");
  const server = createOnlineServer("test-only-password-12345", dir, true);
  if (previous === undefined) delete process.env.KHAN_AUDIT_FILE;
  else process.env.KHAN_AUDIT_FILE = previous;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base + "/")).status, 200);
    assert.equal((await fetch(base + "/v1/status")).status, 200);
    assert.deepEqual(await (await fetch(base + "/v1/ghost")).json(), { ghosts: [] });
    for (const [method, path] of [["GET", "/v1/settings"], ["POST", "/v1/settings"], ["GET", "/v1/audit"], ["POST", "/v1/ghost"], ["POST", "/v1/swarm"], ["POST", "/v1/voice"], ["POST", "/v1/tasks/t/approve"], ["POST", "/v1/tasks/t/reject"], ["POST", "/v1/tasks/t/cancel"]]) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.headers.has("www-authenticate"), false);
    }
    const response = await fetch(base + "/v1/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: "Analyze this project" }) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
    const { task } = await response.json() as { task: { id: string } };
    const stranger = await fetch(base + `/v1/tasks/${task.id}`);
    assert.equal(stranger.status, 404, "another visitor cannot read this task");
    const strangerCookie = stranger.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await fetch(base + `/v1/tasks/${task.id}/events`, { headers: { Cookie: strangerCookie, Accept: "text/event-stream" } })).status, 404, "another visitor cannot stream this task");
    assert.equal((await fetch(base + `/v1/tasks/${task.id}`, { headers: { Cookie: "panos_demo=" + "a".repeat(48) } })).status, 404, "an invented cookie cannot select the task's session");
    const stream = await fetch(base + `/v1/tasks/${task.id}/events`, { headers: { Cookie: cookie, Accept: "text/event-stream" } });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /event: end/);
    const report = await (await fetch(base + `/v1/tasks/${task.id}`, { headers: { Cookie: cookie } })).json() as { task: { status: string }; verification: { passed: boolean } };
    assert.equal(report.task.status, "completed");
    assert.equal(report.verification.passed, true);
    const headers = { Authorization: `Basic ${Buffer.from("panos:test-only-password-12345").toString("base64")}` };
    assert.equal((await fetch(base + "/v1/settings", { headers })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
