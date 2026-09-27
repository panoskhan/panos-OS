import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKhanApiServer } from "../../apps/api/src/index";
import type { AuditEntry, AuditResponse, StatusResponse, TaskResponse } from "../../packages/contracts/src/api";
import { AuditLog, FileAuditSink, verifyChain, type AuditLoad, type AuditSink } from "../../services/audit/src/index";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";

const ANALYSIS_GOAL = "Analyze this project and identify the next engineering tasks.";
const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

async function withApi(fn: (base: string, orchestrator: KhanOrchestrator, audit: AuditLog) => Promise<void>, audit = new AuditLog()) {
  const orchestrator = new KhanOrchestrator(undefined, undefined, undefined, undefined, audit);
  const server = createKhanApiServer(orchestrator);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, orchestrator, audit);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function createTask(base: string, goal: string): Promise<TaskResponse> {
  const response = await fetch(`${base}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal })
  });
  assert.equal(response.status, 201);
  return (await response.json()) as TaskResponse;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function getAudit(base: string, query = ""): Promise<{ response: Response; body: AuditResponse }> {
  const response = await fetch(`${base}/v1/audit${query}`);
  return { response, body: (await response.json()) as AuditResponse };
}

/** A GitHub task taken through its approval (with a reason), then an analysis task. Returns the ids. */
async function runTasks(base: string, orchestrator: KhanOrchestrator) {
  const github = await createTask(base, GITHUB_GOAL);
  await orchestrator.whenSettled(github.task.id);
  assert.equal((await post(`${base}/v1/tasks/${github.task.id}/approve`, { reason: "Reviewed the diff" })).status, 202);
  await orchestrator.whenSettled(github.task.id);
  const analysis = await createTask(base, ANALYSIS_GOAL);
  await orchestrator.whenSettled(analysis.task.id);
  return { github: github.task.id, analysis: analysis.task.id };
}

test("GET /v1/audit returns the full record of an approved task, and the hash chain verifies from the HTTP output alone", async () => {
  await withApi(async (base, orchestrator) => {
    const { github } = await runTasks(base, orchestrator);

    const { response, body } = await getAudit(base, "?order=asc&limit=500");

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(body.page, { order: "asc", limit: 500, nextCursor: null });
    assert.equal(body.total, body.entries.length);
    assert.deepEqual(verifyChain(body.entries), { ok: true, entries: body.entries.length });

    const approved = body.entries.find((entry) => entry.type === "task.approved");
    assert.equal(approved?.taskId, github);
    assert.equal(approved?.actor, "anonymous");
    assert.equal(approved?.data.reason, "Reviewed the diff");
    assert.deepEqual(approved?.data.permissions, ["workspace.read", "workspace.write", "github.write"]);
    const types = body.entries.filter((entry) => entry.taskId === github).map((entry) => entry.type);
    for (const expected of ["task.created", "plan.created", "permission.decided", "step.waiting_approval", "task.approved", "qa.verdict", "task.completed"]) {
      assert.ok(types.includes(expected as AuditEntry["type"]), `${expected} is recorded`);
    }
  });
});

test("paging with limit and cursor walks the whole log once, oldest first or newest first", async () => {
  await withApi(async (base, orchestrator) => {
    await runTasks(base, orchestrator);
    const all = (await getAudit(base, "?order=asc&limit=500")).body.entries;
    assert.ok(all.length > 12, "enough entries to need several pages");

    for (const order of ["asc", "desc"] as const) {
      const walked: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const { body }: { body: AuditResponse } = await getAudit(base, `?order=${order}&limit=7${cursor ? `&cursor=${cursor}` : ""}`);
        assert.equal(body.total, all.length);
        assert.equal(body.page.limit, 7);
        assert.ok(body.entries.length <= 7);
        walked.push(...body.entries.map((entry) => entry.id));
        cursor = body.page.nextCursor;
        pages++;
      } while (cursor !== null);

      const expected = all.map((entry) => entry.id);
      assert.deepEqual(walked, order === "asc" ? expected : [...expected].reverse());
      assert.equal(pages, Math.ceil(all.length / 7));
    }

    const defaults = (await getAudit(base)).body;
    assert.equal(defaults.page.order, "desc", "newest first by default");
    assert.equal(defaults.page.limit, 100);
    assert.equal(defaults.entries[0].id, all.length);
  });
});

test("filters narrow by task, type, actor and time", async () => {
  await withApi(async (base, orchestrator) => {
    const ids = await runTasks(base, orchestrator);
    const all = (await getAudit(base, "?order=asc&limit=500")).body.entries;

    const byTask = (await getAudit(base, `?taskId=${ids.analysis}&order=asc&limit=500`)).body;
    assert.deepEqual(byTask.entries.map((entry) => entry.id), all.filter((entry) => entry.taskId === ids.analysis).map((entry) => entry.id));
    assert.equal(byTask.total, byTask.entries.length);

    const byType = (await getAudit(base, "?type=task.approved")).body;
    assert.equal(byType.total, 1);
    assert.equal(byType.entries[0].taskId, ids.github);

    const byActor = (await getAudit(base, "?actor=anonymous&limit=500")).body;
    assert.deepEqual(byActor.entries.map((entry) => entry.type).sort(), all.filter((entry) => entry.actor === "anonymous").map((entry) => entry.type).sort());
    assert.ok(byActor.total < all.length, "system entries are excluded");

    const middle = all[Math.floor(all.length / 2)];
    const exactly = (await getAudit(base, `?since=${encodeURIComponent(middle.at)}&until=${encodeURIComponent(middle.at)}&limit=500`)).body;
    assert.ok(exactly.entries.some((entry) => entry.id === middle.id));
    assert.ok(exactly.entries.every((entry) => entry.at === middle.at));

    assert.equal((await getAudit(base, "?since=2999-01-01T00:00:00Z")).body.total, 0);
    assert.equal((await getAudit(base, "?type=no.such.type")).body.total, 0);
    assert.equal((await getAudit(base, "?taskId=task_missing")).body.entries.length, 0);
  });
});

test("bad query parameters get a 400 that names the problem", async () => {
  await withApi(async (base) => {
    const cases: Array<[string, string]> = [
      ["?limit=0", "invalid_limit"],
      ["?limit=501", "invalid_limit"],
      ["?limit=abc", "invalid_limit"],
      ["?limit=-5", "invalid_limit"],
      ["?order=sideways", "invalid_order"],
      ["?cursor=0", "invalid_cursor"],
      ["?cursor=abc", "invalid_cursor"],
      ["?since=yesterday", "invalid_since"],
      ["?until=", "invalid_until"],
      ["?taskId=", "invalid_taskId"],
      ["?type=", "invalid_type"],
      ["?actor=", "invalid_actor"]
    ];
    for (const [query, error] of cases) {
      const response = await fetch(`${base}/v1/audit${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(((await response.json()) as { error: string }).error, error, query);
    }
    assert.equal((await fetch(`${base}/v1/audit?limit=500`)).status, 200, "500 is allowed");
  });
});

test("an attempt refused because of the task's state is itself recorded", async () => {
  await withApi(async (base, orchestrator) => {
    const { analysis } = await runTasks(base, orchestrator);

    const approve = await post(`${base}/v1/tasks/${analysis}/approve`, { reason: "please" });
    const cancel = await post(`${base}/v1/tasks/${analysis}/cancel`);
    assert.equal(approve.status, 409);
    assert.equal(cancel.status, 409);

    const refused = (await getAudit(base, "?type=request.refused&order=asc")).body.entries;
    assert.deepEqual(refused.map((entry) => [entry.taskId, entry.actor, entry.data.action, entry.data.taskStatus]), [
      [analysis, "anonymous", "approve", "completed"],
      [analysis, "anonymous", "cancel", "completed"]
    ]);
    assert.match(String(refused[0].data.reason), /Cannot approve task/);
    assert.equal(verifyChain((await getAudit(base, "?order=asc&limit=500")).body.entries).ok, true, "refusals are part of the chain");
  });
});

test("the audit endpoint is read-only and answers configured browser origins", async () => {
  await withApi(async (base) => {
    const post405 = await fetch(`${base}/v1/audit`, { method: "POST" });
    assert.equal(post405.status, 405);
    assert.equal(post405.headers.get("allow"), "GET");

    const allowed = "http://127.0.0.1:5173";
    assert.equal((await fetch(`${base}/v1/audit`, { headers: { origin: allowed } })).headers.get("access-control-allow-origin"), allowed);
    assert.equal((await fetch(`${base}/v1/audit`, { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin"), null);
  });
});

test("a file-backed log is what the endpoint serves, and /v1/status reports it as recording", async () => {
  const dir = mkdtempSync(join(tmpdir(), "khan-audit-api-"));
  try {
    const file = join(dir, "audit.jsonl");
    await withApi(
      async (base, orchestrator, audit) => {
        await runTasks(base, orchestrator);
        const { body } = await getAudit(base, "?order=asc&limit=500");

        const onDisk = readFileSync(file, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as AuditEntry);
        assert.deepEqual(onDisk, body.entries, "what the API serves is exactly what is on disk");

        const status = (await (await fetch(`${base}/v1/status`)).json()) as StatusResponse;
        const component = status.components.find((entry) => entry.id === "audit")!;
        assert.equal(component.state, "up");
        assert.deepEqual(component.metrics, { entries: body.total, writable: 1, pending: 0 });
        assert.match(component.detail, new RegExp(`Recording to .*audit\\.jsonl\\. ${body.total} entries, file writable, hash chain intact\\.`));
        assert.equal(status.status, "ok");
        assert.equal(audit.health().storage, "file");
      },
      new AuditLog(new FileAuditSink(file))
    );

    // A second server on the same file continues the same chain.
    await withApi(
      async (base) => {
        const before = (await getAudit(base)).body.total;
        await createTask(base, ANALYSIS_GOAL);
        const { body } = await getAudit(base, "?order=asc&limit=500");
        assert.ok(body.total > before);
        assert.deepEqual(verifyChain(body.entries), { ok: true, entries: body.total });
      },
      new AuditLog(new FileAuditSink(file))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/v1/status shows the audit log as down, with the reason, when it cannot write, while tasks carry on", async () => {
  class FailingSink implements AuditSink {
    readonly kind = "file" as const;
    readonly location = "/var/khan/audit.jsonl";
    load(): AuditLoad {
      return { entries: [], problems: [] };
    }
    append(): void {
      throw new Error("EACCES: permission denied");
    }
    health() {
      return { writable: false, detail: "EACCES: permission denied" };
    }
  }
  await withApi(
    async (base, orchestrator) => {
      const task = await createTask(base, ANALYSIS_GOAL);
      const report = await orchestrator.whenSettled(task.task.id);
      assert.equal(report.task.status, "completed", "a broken audit sink does not stop tasks");

      const response = await fetch(`${base}/v1/status`);
      const status = (await response.json()) as StatusResponse;
      const component = status.components.find((entry) => entry.id === "audit")!;
      assert.equal(response.status, 200);
      assert.equal(status.status, "degraded");
      assert.equal(component.state, "down");
      assert.equal(component.metrics?.writable, 0);
      assert.ok((component.metrics?.pending ?? 0) > 0);
      assert.match(component.detail, /Not writing to \/var\/khan\/audit\.jsonl: EACCES: permission denied/);
      assert.equal(((await getAudit(base)).body.total), component.metrics?.entries, "entries are still readable from memory");
    },
    new AuditLog(new FailingSink())
  );
});
