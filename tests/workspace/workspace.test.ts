import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspaceError, WorkspaceManager, type WorkspaceCommand } from "../../services/workspace/src/index";
import { createWorkspaceCodingHandler, extractJsonObject } from "../../agents/coding/src/workspace-handler";
import { KhanOrchestrator } from "../../services/orchestrator/src/orchestrator";
import { verifyIndependentQa } from "../../agents/qa/src/index";
import type { PlanStep } from "../../agents/planner/src/index";

const SECRET = "nvapi-super-secret-value";

const node = (script: string): WorkspaceCommand => ({ file: process.execPath, args: ["-e", script] });

/** A project on disk with things that must never reach a workspace. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "khan-ws-"));
  const source = join(dir, "project");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(source, ".git"));
  mkdirSync(join(source, "data"));
  writeFileSync(join(source, "src", "a.txt"), "hello");
  writeFileSync(join(source, "README.md"), "# project");
  writeFileSync(join(source, ".env"), `NVIDIA_API_KEY=${SECRET}`);
  writeFileSync(join(source, ".git", "config"), "git config");
  writeFileSync(join(source, "data", "audit.jsonl"), "audit");
  writeFileSync(join(source, "node_modules", "dep", "index.js"), "dep");
  return {
    dir,
    source,
    manager: (commands?: Record<string, WorkspaceCommand>, timeoutMs?: number) =>
      new WorkspaceManager({ source, base: join(dir, "workspaces"), commands, timeoutMs }),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

const step = (id: string, permissions: string[]): PlanStep => ({ id, title: `Do ${id}`, agent: "coding", permissions, dependsOn: [] });
const READ = ["workspace.read"];
const WRITE = ["workspace.read", "workspace.write"];
const context = (goal = "Add a greeting", inputs: Record<string, unknown> = {}) => ({ taskId: "task_1", projectId: "p", goal, inputs });

/** A model that answers from a script, and remembers what it was asked. */
function scripted(replies: string[]) {
  const asked: Array<Array<{ role: string; content: string }>> = [];
  return {
    asked,
    async chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
      asked.push(structuredClone(messages));
      const reply = replies.shift();
      assert.ok(reply !== undefined, "the agent asked the model more often than the script expects");
      return { text: reply, model: "fake/model" };
    }
  };
}
const call = (value: Record<string, unknown>) => JSON.stringify(value);

test("a workspace is a copy without secrets, dependencies, git history or data, and the source is never touched", () => {
  const f = fixture();
  try {
    const workspace = f.manager().forTask("task_1");

    assert.ok(existsSync(join(workspace.root, "src", "a.txt")));
    assert.ok(existsSync(join(workspace.root, "README.md")));
    for (const name of [".env", ".git", "data"]) assert.equal(existsSync(join(workspace.root, name)), false, `${name} must not be copied`);
    assert.deepEqual(workspace.list("."), ["README.md", "src/"], "node_modules exists as a link but is hidden from the model");

    workspace.write("src/a.txt", "changed");
    assert.equal(readFileSync(join(f.source, "src", "a.txt"), "utf8"), "hello", "the real project is untouched");
    assert.equal(f.manager().forTask("task_1").read("src/a.txt").content, "changed", "the same task gets the same workspace back");
    assert.equal(f.manager().forTask("task_2").read("src/a.txt").content, "hello", "another task starts from a fresh copy");
  } finally {
    f.cleanup();
  }
});

test("workspaces can live inside the project itself (data/workspaces), as they do when the API runs", () => {
  const f = fixture();
  try {
    const inside = new WorkspaceManager({ source: f.source, base: join(f.source, "data", "workspaces") });

    const first = inside.forTask("task_1");
    assert.equal(first.read("src/a.txt").content, "hello");
    const second = inside.forTask("task_2");
    assert.deepEqual(second.list("."), ["README.md", "src/"], "an earlier workspace is not copied into a later one");
    assert.equal(existsSync(join(second.root, "data")), false);
  } finally {
    f.cleanup();
  }
});

test("paths cannot escape: parent folders, absolute paths, secrets, git, dependencies and links out are all refused", () => {
  const f = fixture();
  try {
    const workspace = f.manager().forTask("task_1");
    const outside = join(f.dir, "outside.txt");
    writeFileSync(outside, "outside");
    let linked = true;
    try {
      symlinkSync(f.dir, join(workspace.root, "escape"), "junction");
    } catch {
      linked = false;
    }

    const refused = ["../outside.txt", "src/../../outside.txt", outside, "C:\\Windows\\win.ini", "/etc/passwd", ".env", ".env.local", ".git/config", "node_modules/dep/index.js", "data/audit.jsonl", "", "  "];
    if (linked) refused.push("escape/outside.txt");
    for (const path of refused) {
      assert.throws(() => workspace.read(path), WorkspaceError, `read ${JSON.stringify(path)}`);
      assert.throws(() => workspace.write(path, "x"), WorkspaceError, `write ${JSON.stringify(path)}`);
    }
    assert.throws(() => workspace.read(42), WorkspaceError);
    assert.throws(() => workspace.write("ok.txt", 42), WorkspaceError);
    assert.throws(() => workspace.write("big.txt", "x".repeat(100_001)), /too large/);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  } finally {
    f.cleanup();
  }
});

test("only the named commands run, and they never see the API key", async () => {
  const f = fixture();
  const before = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = SECRET;
  try {
    const workspace = f.manager({ test: node("console.log('key=' + (process.env.NVIDIA_API_KEY ?? 'absent'))") }).forTask("task_1");

    const result = await workspace.run("test");
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /key=absent/);
    assert.ok(!result.output.includes(SECRET));

    await assert.rejects(workspace.run("rm -rf /"), /Unknown command/);
    await assert.rejects(workspace.run("build"), /Allowed: test/);
    await assert.rejects(workspace.run({ file: "node" }), WorkspaceError);
  } finally {
    if (before === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = before;
    f.cleanup();
  }
});

test("a failing command reports its exit code and output, and a runaway one is stopped", async () => {
  const f = fixture();
  try {
    const workspace = f.manager({ test: node("console.log('boom'); process.exit(3)"), slow: node("setInterval(() => {}, 1000)") }, 300).forTask("task_1");

    const failed = await workspace.run("test");
    assert.deepEqual([failed.exitCode, failed.timedOut], [3, false]);
    assert.match(failed.output, /boom/);

    const slow = await workspace.run("slow");
    assert.equal(slow.timedOut, true);
    assert.match(slow.output, /stopped after 300ms/);
  } finally {
    f.cleanup();
  }
});

test("model replies are parsed even when wrapped in prose or code fences, and nested braces and strings are respected", () => {
  assert.deepEqual(extractJsonObject('{"tool":"list_dir"}'), { tool: "list_dir" });
  assert.deepEqual(extractJsonObject('Sure!\n```json\n{"tool":"read_file","path":"a.ts"}\n```'), { tool: "read_file", path: "a.ts" });
  assert.deepEqual(extractJsonObject('{"tool":"write_file","content":"if (x) { return \\"}\\"; }"}'), { tool: "write_file", content: 'if (x) { return "}"; }' });
  assert.deepEqual(extractJsonObject('{not json} then {"tool":"finish"}'), { tool: "finish" });
  assert.equal(extractJsonObject("no json here"), null);
  assert.equal(extractJsonObject("[1,2]"), null);
  assert.equal(extractJsonObject('{"unclosed":'), null);
});

test("the agent explores, edits and tests in the sandbox, and reports what the harness saw, not what the model claims", async () => {
  const f = fixture();
  try {
    const model = scripted([
      call({ tool: "list_dir", path: "." }),
      `Let me look.\n${call({ tool: "read_file", path: "src/a.txt" })}`,
      call({ tool: "write_file", path: "src/greeting.txt", content: "hi there" }),
      call({ tool: "run", command: "test" }),
      call({ tool: "finish", findings: ["- Added a greeting file", "Tests pass", "I also fixed 40 other bugs"] })
    ]);
    const handler = createWorkspaceCodingHandler(model, f.manager({ test: node("process.exit(0)") }));

    const result = await handler(step("implement", WRITE), context());

    assert.equal(result.status, "success");
    assert.match(result.summary, /Add a greeting/);
    assert.deepEqual(result.artifacts, ["src/greeting.txt"]);
    assert.match(result.findings![0], /sandbox copy.*The real project was not changed/);
    assert.ok(result.findings!.includes("Read 1 file(s): src/a.txt"));
    assert.ok(result.findings!.includes("Wrote src/greeting.txt (8 bytes)"));
    assert.ok(result.findings!.some((finding) => /^Ran test: passed \(exit 0, \d+ms\)$/.test(finding)));
    assert.ok(result.findings!.includes("Model: Added a greeting file"), "the model's own claims are labelled as the model's");
    assert.equal(verifyIndependentQa([result], "Add a greeting").passed, true);

    assert.equal(readFileSync(join(f.dir, "workspaces", "task_1", "src", "greeting.txt"), "utf8"), "hi there");
    assert.equal(existsSync(join(f.source, "src", "greeting.txt")), false, "nothing reaches the real project");
    const listing = model.asked[1].at(-1)!.content;
    assert.equal(listing, "README.md\nsrc/", "the model was shown the folder without secrets or dependencies");
  } finally {
    f.cleanup();
  }
});

test("a read-only step cannot write, is told why, and can carry on", async () => {
  const f = fixture();
  try {
    const model = scripted([
      call({ tool: "write_file", path: "src/x.txt", content: "no" }),
      call({ tool: "read_file", path: ".env" }),
      call({ tool: "finish", findings: ["Could not write"] })
    ]);
    const result = await createWorkspaceCodingHandler(model, f.manager())(step("inspect", READ), context());

    assert.equal(result.status, "success");
    assert.deepEqual(result.artifacts, []);
    assert.equal(model.asked[1].at(-1)!.content, "Error: Writing is not allowed in this step");
    assert.match(model.asked[2].at(-1)!.content, /^Error: Path is not accessible/, "the secrets file is refused");
    assert.equal(existsSync(join(f.dir, "workspaces", "task_1", "src", "x.txt")), false);
  } finally {
    f.cleanup();
  }
});

test("failing tests fail the test step honestly, and a forgotten test run is done by the harness anyway", async () => {
  const f = fixture();
  try {
    const failing = f.manager({ test: node("console.log('2 tests failed'); process.exit(1)") });
    const forgetful = scripted([call({ tool: "finish", findings: ["All good, tests pass"] })]);

    const result = await createWorkspaceCodingHandler(forgetful, failing)(step("test", READ), context());

    assert.equal(result.status, "failure");
    assert.match(result.summary, /^Tests failed in coding agent step 'test' for goal: Add a greeting/);
    assert.ok(result.findings!.some((finding) => /^Ran test: FAILED \(exit 1/.test(finding)));
    assert.ok(result.findings!.some((finding) => /Last test output: .*2 tests failed/.test(finding)));
    assert.ok(result.findings!.includes("Model: All good, tests pass"), "the model's false claim is on record, next to the truth");
  } finally {
    f.cleanup();
  }
});

test("a garbled reply is corrected once and a model that never finishes fails the step", async () => {
  const f = fixture();
  try {
    const recovering = scripted(["I think we should look around.", call({ tool: "finish", findings: ["ok"] })]);
    const result = await createWorkspaceCodingHandler(recovering, f.manager())(step("inspect", READ), context());
    assert.equal(result.status, "success");
    assert.match(recovering.asked[1].at(-1)!.content, /exactly one JSON object/);

    const endless = scripted(Array.from({ length: 3 }, () => call({ tool: "list_dir", path: "." })));
    await assert.rejects(async () => createWorkspaceCodingHandler(endless, f.manager(), { maxTurns: 3 })(step("inspect", READ), context()), /did not finish step 'inspect' within 3 turns/);
  } finally {
    f.cleanup();
  }
});

test("a whole task runs through the orchestrator with the workspace agent, and a failing test fails the task", async () => {
  const f = fixture();
  try {
    const script = () => [
      call({ tool: "list_dir" }),
      call({ tool: "finish", findings: ["Inspected"] }), // inspect
      call({ tool: "write_file", path: "src/fix.txt", content: "fixed" }),
      call({ tool: "finish", findings: ["Fixed it"] }), // implement
      call({ tool: "finish", findings: ["Tested"] }) // test
    ];

    const passing = new KhanOrchestrator(undefined, undefined, createWorkspaceCodingHandler(scripted(script()), f.manager({ test: node("process.exit(0)") })));
    const ok = await passing.run("Fix the bug");
    assert.equal(ok.task.status, "completed");
    assert.deepEqual(ok.execution.find((entry) => entry.stepId === "implement")?.output?.artifacts, ["src/fix.txt"]);

    const failing = new KhanOrchestrator(undefined, undefined, createWorkspaceCodingHandler(scripted(script()), new WorkspaceManager({ source: f.source, base: join(f.dir, "other"), commands: { test: node("process.exit(1)") } })));
    const bad = await failing.run("Fix the bug");
    assert.equal(bad.task.status, "failed");
    assert.equal(bad.execution.find((entry) => entry.stepId === "test")?.status, "failed");
    assert.match(JSON.stringify(bad.verification.findings), /Ran test: FAILED/);
  } finally {
    f.cleanup();
  }
});
