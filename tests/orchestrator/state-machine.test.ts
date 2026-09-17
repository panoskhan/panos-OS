import { canTransition, transition } from "../../../services/orchestrator/src/state-machine";

describe("task state machine", () => {
  it("allows normal execution flow", () => {
    expect(canTransition("received", "understanding")).toBe(true);
    expect(canTransition("planning", "executing")).toBe(true);
    expect(transition("verifying", "completed")).toBe("completed");
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("completed", "executing")).toBe(false);
    expect(() => transition("completed", "executing")).toThrow();
  });
});
