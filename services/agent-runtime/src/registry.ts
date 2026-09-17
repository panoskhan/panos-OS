import type { AgentDefinition } from "../../../packages/contracts/src/agent";

const registry = new Map<string, AgentDefinition>();

export function registerAgent(agent: AgentDefinition): void {
  if (registry.has(agent.id)) {
    throw new Error(`Agent already registered: ${agent.id}`);
  }
  registry.set(agent.id, agent);
}

export function getAgent(id: string): AgentDefinition {
  const agent = registry.get(id);
  if (!agent) throw new Error(`Unknown agent: ${id}`);
  return agent;
}

export function listAgents(): AgentDefinition[] {
  return [...registry.values()];
}
