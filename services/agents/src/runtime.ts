import type { AgentContext, AgentResult } from "../../../packages/contracts/src/agent";
import type { PlanStep } from "../../../agents/planner/src/index";
import { PermissionEngine, type PermissionDecision } from "../../permissions/src/index";

export type AgentHandler = (step: PlanStep, context: AgentContext) => AgentResult;

export interface RuntimeExecution {
  stepId: string;
  agent: string;
  status: "completed" | "failed" | "waiting_approval";
  output?: AgentResult;
  permission: PermissionDecision;
}

export interface ExecuteStepOptions {
  approvedPermissions?: Iterable<string>;
}

export class AgentRuntime {
  private readonly handlers = new Map<string, AgentHandler>();

  constructor(private readonly permissions = new PermissionEngine()) {}

  register(agentId: string, handler: AgentHandler): void {
    if (!agentId.trim()) throw new Error("Agent ID is required");
    if (this.handlers.has(agentId)) throw new Error(`Agent already registered: ${agentId}`);
    this.handlers.set(agentId, handler);
  }

  executeStep(step: PlanStep, context: AgentContext, options: ExecuteStepOptions = {}): RuntimeExecution {
    const permission = this.permissions.decide(step.permissions, options.approvedPermissions);
    if (permission.requiresApproval) {
      return { stepId: step.id, agent: step.agent, status: "waiting_approval", permission };
    }
    if (!permission.allowed) {
      return { stepId: step.id, agent: step.agent, status: "failed", permission };
    }

    const handler = this.handlers.get(step.agent);
    if (!handler) {
      const output: AgentResult = { status: "failure", summary: `Unknown agent: ${step.agent}` };
      return { stepId: step.id, agent: step.agent, status: "failed", output, permission };
    }

    const output = handler(step, context);
    return {
      stepId: step.id,
      agent: step.agent,
      status: output.status === "success" ? "completed" : "failed",
      output,
      permission
    };
  }
}
