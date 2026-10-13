import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerWorkspace, OwnerError } from "../../services/owner/src/index";
import { ModelClient } from "../../services/model-router/src/client";

test("project uploads, suggestions and limits survive restart while responses and backups omit the model key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "panos-owner-"));
  let calls = 0;
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      calls++;
      const data = JSON.parse(body);
      assert.match(data.messages[1].content, /src\/hello.ts/);
      assert.equal(data.max_tokens, 2048);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "--- a/src/hello.ts\n+++ b/src/hello.ts\n@@\n-old\n+new" } }] }));
    });
  });
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  const factory = (apiKey: string, model: string) => new ModelClient({ apiKey, model, baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`, timeoutMs: 1000 }, Date.now, []);
  try {
    const owner = new OwnerWorkspace(directory, factory);
    const project = owner.create("My project");
    owner.upload(project.id, [{ path: "src/hello.ts", content: "old" }]);
    await assert.rejects(owner.suggest(project.id, "Improve it"), (e: unknown) => e instanceof OwnerError && e.status === 409);
    owner.configure({ apiKey: "test-private-key", model: "test/model", enabled: true, dailyLimit: 1, estimatedCostPerCall: .01 });
    const result = await owner.suggest(project.id, "Improve it");
    assert.equal(calls, 1);
    assert.match(result.suggestions[0].text, /\+new/);
    assert.equal(result.files[0].content, "old", "proposals must not change uploaded files");
    assert.equal(owner.overview().usage.estimatedCost, .01);
    const restarted = new OwnerWorkspace(directory, factory);
    assert.deepEqual(restarted.get(project.id), result);
    await assert.rejects(restarted.suggest(project.id, "More changes"), (e: unknown) => e instanceof OwnerError && e.status === 429);
    assert.equal(calls, 1, "the limit survives restart");
    assert.equal(JSON.stringify(restarted.overview()).includes("test-private-key"), false);
    assert.equal(JSON.stringify(restarted.backup()).includes("test-private-key"), false);
    assert.equal(statSync(join(directory, "owner.json")).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")).projects.length, 1);
    restarted.remove(project.id);
    assert.equal(new OwnerWorkspace(directory).overview().projects.length, 0);
  } finally {
    fake.closeAllConnections();
    await new Promise<void>(resolve => fake.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner uploads reject path traversal, secrets, duplicate paths and invalid limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "panos-owner-"));
  try {
    const owner = new OwnerWorkspace(directory);
    const project = owner.create("Uploads");
    for (const path of ["../secret", "/etc/passwd", "a/../../secret", ".env", "src/.env.local", ".git/config", "node_modules/a", "a\\b", "a\u0000b"])
      assert.throws(() => owner.upload(project.id, [{ path, content: "text" }]), OwnerError);
    assert.throws(() => owner.upload(project.id, [{ path: "a", content: "x" }, { path: "a", content: "y" }]), OwnerError);
    assert.throws(() => owner.upload(project.id, [{ path: "a", content: "x".repeat(100001) }]), OwnerError);
    assert.throws(() => owner.configure({ dailyLimit: 0 }), OwnerError);
    assert.throws(() => owner.configure({ estimatedCostPerCall: -1 }), OwnerError);
    assert.throws(() => owner.configure({ apiKey: "", enabled: true }), OwnerError);
    assert.equal(owner.get(project.id).files.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("model failures consume the persisted limit and do not reveal echoed credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "panos-owner-"));
  const fake = createServer((_req, res) => res.writeHead(401).end("test-private-key"));
  await new Promise<void>(resolve => fake.listen(0, "127.0.0.1", resolve));
  try {
    const owner = new OwnerWorkspace(directory, (apiKey, model) => new ModelClient({ apiKey, model, baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, timeoutMs: 1000 }, Date.now, []));
    owner.configure({ apiKey: "test-private-key", enabled: true, dailyLimit: 1 });
    await assert.rejects(owner.chat([{ role: "user", content: "Hello" }]), e => e instanceof OwnerError && e.status === 502 && !e.message.includes("test-private-key"));
    assert.equal(owner.overview().usage.failures, 1);
    await assert.rejects(owner.chat([{ role: "user", content: "Hello" }]), e => e instanceof OwnerError && e.status === 429);
  } finally {
    fake.closeAllConnections(); await new Promise<void>(resolve => fake.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
