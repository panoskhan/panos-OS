import assert from "node:assert/strict";
import test from "node:test";
import { createKhanWebServer } from "../../apps/web/src/server";

test("web dashboard serves health and executes a task", async () => {
  const server = createKhanWebServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "khan-os-web" });

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /KHAN OS/);
    assert.match(html, /Run KHAN/);
    assert.match(html, /Approval required/);

    const task = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Analyze this project and identify the next engineering tasks." })
    });
    assert.equal(task.status, 200);
    const report = await task.json() as { task: { status: string; risk: string }; verification: { passed: boolean } };
    assert.equal(report.task.status, "completed");
    assert.equal(report.task.risk, "read");
    assert.equal(report.verification.passed, true);

    const approvalTask = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Implement the fix and push the changes to GitHub." })
    });
    assert.equal(approvalTask.status, 200);
    const approvalReport = await approvalTask.json() as {
      task: { status: string; risk: string };
      execution: Array<{ stepId: string; status: string }>;
      verification: { checks: string[]; findings: string[] };
    };
    assert.equal(approvalReport.task.status, "waiting_approval");
    assert.equal(approvalReport.task.risk, "external");
    assert.deepEqual(approvalReport.execution.map((entry) => [entry.stepId, entry.status]), [
      ["inspect", "completed"],
      ["implement", "waiting_approval"]
    ]);
    assert.deepEqual(approvalReport.verification.checks, ["approval-required"]);
    assert.deepEqual(approvalReport.verification.findings, ["workspace.read", "workspace.write", "github.write"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
