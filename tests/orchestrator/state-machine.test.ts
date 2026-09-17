import assert from "node:assert/strict";
import test from "node:test";
import { canTransition, transition } from "../../services/orchestrator/src/state-machine";

test("task state machine allows normal execution flow", () => {
  assert.equal(canTransition("received", "understanding"), true);
  assert.equal(canTransition("planning", "executing"), true);
  assert.equal(transition("verifying", "completed"), "completed");
});

test("task state machine rejects invalid transitions", () => {
  assert.equal(canTransition("completed", "executing"), false);
  assert.throws(() => transition("completed", "executing"));
});
