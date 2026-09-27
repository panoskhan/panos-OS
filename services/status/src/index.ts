import type { AgentResult } from "../../../packages/contracts/src/agent";
import type { ComponentId, ComponentStatus, StatusResponse } from "../../../packages/contracts/src/api";
import type { VerificationResult } from "../../../agents/qa/src/index";
import type { OrchestratorDiagnostics } from "../../orchestrator/src/orchestrator";

export interface StatusDependencies {
  service: string;
  version: string;
  /** When the process started, in ms. */
  startedAt: number;
  now?: () => number;
  /** The live components to check. Injected so tests can hand in broken ones. */
  diagnostics(): OrchestratorDiagnostics;
  /** Every agent a plan step may name. */
  planAgents: readonly string[];
  /** The independent QA verification function. */
  verify(results: AgentResult[], goal: string): VerificationResult;
}

type Outcome = Omit<ComponentStatus, "id" | "name">;

const plural = (count: number, word: string) => {
  if (count === 1) return `${count} ${word}`;
  return `${count} ${word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`}`;
};

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Runs one probe. A probe that throws means its component is down, never that the status call fails. */
function run(id: ComponentId, name: string, probe: () => Outcome): ComponentStatus {
  try {
    return { id, name, ...probe() };
  } catch (error) {
    return { id, name, state: "down", detail: `Self-test crashed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const outcome = (problems: string[], ok: string): Outcome =>
  problems.length ? { state: "down", detail: problems.join("; ") } : { state: "up", detail: ok };

function probeOrchestrator(deps: StatusDependencies, uptimeSeconds: number): Outcome {
  const { tasks } = deps.diagnostics();
  return {
    state: "up",
    detail: `Up ${formatDuration(uptimeSeconds)}. ${plural(tasks.total, "task")} (${tasks.running} running, ${tasks.waitingApproval} awaiting approval).`,
    metrics: { tasks: tasks.total, running: tasks.running, waitingApproval: tasks.waitingApproval }
  };
}

function probeAgents(deps: StatusDependencies): Outcome {
  const registered = deps.diagnostics().registeredAgents;
  const missing = deps.planAgents.filter((agent) => !registered.includes(agent));
  return outcome(
    missing.length ? [`No handler registered for: ${missing.join(", ")}`] : [],
    `Handlers registered for every plan agent: ${deps.planAgents.join(", ")}.`
  );
}

function probePermissions(deps: StatusDependencies): Outcome {
  const engine = deps.diagnostics().permissions;
  const unknownPermission = "status.self-test.unknown";
  const problems: string[] = [];

  if (!engine.decide(["workspace.read"]).allowed) problems.push("workspace.read is not allowed");
  const gated = engine.decide(["github.write"]);
  if (gated.allowed || !gated.requiresApproval) problems.push("github.write is not approval-gated");
  const unknown = engine.decide([unknownPermission]);
  if (unknown.allowed || !unknown.deniedPermissions.includes(unknownPermission)) problems.push("unknown permissions are not denied");

  return outcome(problems, "Self-test passed: workspace.read allowed, github.write needs approval, unknown permissions denied.");
}

function probeQa(deps: StatusDependencies): Outcome {
  const goal = "status self-test";
  const valid: AgentResult[] = [{ status: "success", summary: `Completed: ${goal}`, findings: [`Checked: ${goal}`] }];
  const failed: AgentResult[] = [{ status: "failure", summary: `Failed: ${goal}`, findings: ["Simulated failure"] }];
  const unrelated: AgentResult[] = [{ status: "success", summary: "Unrelated work", findings: ["Unrelated finding"] }];
  const problems: string[] = [];

  if (!deps.verify(valid, goal).passed) problems.push("rejected a valid result");
  if (deps.verify(failed, goal).passed) problems.push("accepted a failed result");
  if (deps.verify(unrelated, goal).passed) problems.push("accepted a result that ignores the goal");

  return outcome(problems.length ? [`QA ${problems.join(" and ")}`] : [], "Self-test passed: accepts a valid result, rejects a failed one and one that ignores the goal.");
}

function probeAudit(deps: StatusDependencies): Outcome {
  const audit = deps.diagnostics().audit;
  const metrics = { entries: audit.entries, writable: audit.writable ? 1 : 0, pending: audit.pending };

  if (!audit.integrity.ok) {
    return { state: "down", detail: `Hash chain broken at entry ${audit.integrity.brokenAt}: ${audit.integrity.reason}.`, metrics };
  }
  if (!audit.writable) {
    const where = audit.location ?? "its storage";
    return {
      state: "down",
      detail: `Not writing to ${where}: ${audit.lastError ?? "unknown error"}. ${plural(audit.entries, "entry")} held in memory, ${audit.pending} not yet written.`,
      metrics
    };
  }
  if (audit.storage === "memory") {
    return {
      state: "not_configured",
      detail: `Recording in memory only, so the log is lost on restart. ${plural(audit.entries, "entry")}. Set KHAN_AUDIT_FILE to keep it.`,
      metrics
    };
  }
  return {
    state: "up",
    detail: `Recording to ${audit.location}. ${plural(audit.entries, "entry")}, file writable, hash chain intact.`,
    metrics
  };
}

function probeModelRouter(): Outcome {
  // routeModel is a pure function with no model list, and nothing in the orchestrator calls it.
  return { state: "not_configured", detail: "No models are registered and the router isn't used by the orchestrator yet." };
}

/** Self-tests the live components and reports what it found. Never throws. */
export function collectStatus(deps: StatusDependencies): StatusResponse {
  const now = (deps.now ?? Date.now)();
  const uptimeSeconds = Math.max(0, Math.floor((now - deps.startedAt) / 1000));

  const components = [
    run("orchestrator", "Orchestrator", () => probeOrchestrator(deps, uptimeSeconds)),
    run("model-router", "Model Router", probeModelRouter),
    run("agents", "Agents", () => probeAgents(deps)),
    run("permissions", "Permissions", () => probePermissions(deps)),
    run("qa", "Independent QA", () => probeQa(deps)),
    run("audit", "Audit Log", () => probeAudit(deps))
  ];

  return {
    status: components.some((component) => component.state === "down") ? "degraded" : "ok",
    service: deps.service,
    version: deps.version,
    uptimeSeconds,
    checkedAt: new Date(now).toISOString(),
    components
  };
}
