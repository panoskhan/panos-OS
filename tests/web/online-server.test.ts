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
