import assert from "node:assert/strict";
import test from "node:test";
import { PermissionEngine } from "../../services/permissions/src/index";

test("workspace read/write permissions are enabled", () => {
  const engine = new PermissionEngine();
  assert.equal(engine.decide(["workspace.read"]).allowed, true);
  assert.equal(engine.decide(["workspace.write"]).allowed, true);
  assert.equal(engine.decide(["github.read"]).allowed, true);
});

test("github write is permissioned but still approval-gated", () => {
  const engine = new PermissionEngine();
  const decision = engine.decide(["github.write"]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresApproval, true);
  assert.deepEqual(decision.deniedPermissions, []);
});

test("unknown permissions are denied", () => {
  const engine = new PermissionEngine();
  const decision = engine.decide(["unknown.permission"]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.requiresApproval, false);
  assert.deepEqual(decision.deniedPermissions, ["unknown.permission"]);
});
