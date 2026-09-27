import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { TaskStore, type TaskRecord } from "../../services/orchestrator/src/task-store";
import { FileTaskPersistence, type TaskPersistence } from "../../services/orchestrator/src/task-persistence";
import { gatedHandler, stepStarted, waitForEvent } from "../support/orchestration";

const GITHUB_GOAL = "Implement the fix and push the changes to GitHub.";

function withTempFile<T>(run: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "khan-tasks-"));
  return run(join(dir, "tasks.json"), dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
const boot = (file: string, handler?: ConstructorParameters<typeof KhanOrchestrator>[2]) =>
  new KhanOrchestrator(undefined, undefined, handler, new TaskStore(new FileTaskPersistence(file)));

test("finished and waiting tasks survive a restart, and a waiting task can still be approved afterwards", () =>
  withTempFile(async (file) => {
    const first = boot(file);
    const done = await first.run("Analyze the repository");
    assert.equal(done.task.status, "completed");
    const waiting = await first.run(GITHUB_GOAL);
    assert.equal(waiting.task.status, "waiting_approval");
    const eventsBefore = first.events(waiting.task.id);

    const second = boot(file); // the "restart"
    // JSON drops keys whose value is undefined, so compare what JSON would say about the original.
    const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    assert.deepEqual(second.get(done.task.id), asJson(first.get(done.task.id)));
    assert.deepEqual(second.get(waiting.task.id), asJson(first.get(waiting.task.id)));
    assert.deepEqual(second.events(waiting.task.id), eventsBefore);

    second.approve(waiting.task.id, "after restart");
    const finished = await second.whenSettled(waiting.task.id);
    assert.equal(finished.task.status, "completed");
    const types = second.events(waiting.task.id).map((event) => event.type);
    assert.equal(types.filter((type) => type === "task.approved").length, 1);
    assert.equal(types.at(-1), "task.completed");

    const third = boot(file);
    assert.equal(third.get(waiting.task.id).task.status, "completed", "the change made after the restart was saved too");
  }));

test("a task that was mid-execution when the server stopped is failed honestly, not left executing", () =>
  withTempFile(async (file) => {
    const gate = gatedHandler();
    const first = boot(file, gate.handler);
    const { task } = first.start("Analyze the repository");
    await waitForEvent(first, task.id, stepStarted("inspect"));
    assert.equal(first.get(task.id).execution[0].status, "running");

    const second = boot(file); // the first process "dies" here, its step never finishing
    const report = second.get(task.id);
    assert.equal(report.task.status, "failed");
    assert.equal(report.execution.find((entry) => entry.stepId === "inspect")?.status, "failed");
    assert.deepEqual(report.verification.checks, ["interrupted"]);
    assert.match(report.verification.findings[0], /server stopped while this task was executing/);

    const failed = second.events(task.id).at(-1)!;
    assert.equal(failed.type, "task.failed");
    assert.equal(failed.data.stage, "interrupted");
    assert.equal(failed.data.stepId, "inspect");
    assert.equal(second.auditLog.query({ taskId: task.id, type: "task.failed" }).total, 1, "the audit log records it too");

    assert.equal(boot(file).get(task.id).task.status, "failed", "and it stays failed on the next start");
  }));

test("the file is a single valid JSON document with no temp file left behind", () =>
  withTempFile(async (file, dir) => {
    const orchestrator = boot(file);
    const report = await orchestrator.run("Analyze the repository");

    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.version, 1);
    assert.equal(saved.tasks.length, 1);
    assert.equal(saved.tasks[0].report.task.id, report.task.id);
    assert.ok(Array.isArray(saved.tasks[0].completedSteps), "sets are stored as arrays");
    assert.deepEqual(readdirSync(dir), ["tasks.json"]);
  }));

test("an unreadable task file stops startup with a clear error instead of silently starting empty", () =>
  withTempFile(async (file) => {
    writeFileSync(file, "{ not json");
    assert.throws(() => new TaskStore(new FileTaskPersistence(file)), SyntaxError);
    writeFileSync(file, JSON.stringify({ version: 2, tasks: [] }));
    assert.throws(() => new TaskStore(new FileTaskPersistence(file)), /not a version 1 task file/);
  }));

test("a failing disk is logged but never breaks a task", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const broken: TaskPersistence = {
    location: "nowhere",
    load: () => [] as TaskRecord[],
    save: () => {
      throw new Error("disk full");
    }
  };
  const orchestrator = new KhanOrchestrator(undefined, undefined, undefined, new TaskStore(broken));

  const report = await orchestrator.run("Analyze the repository");

  assert.equal(report.task.status, "completed");
  assert.ok(logged.mock.callCount() > 0);
  assert.match(String(logged.mock.calls[0].arguments[0]), /Could not save task/);
});
