export interface AgentContext {
  taskId: string;
  projectId: string;
  goal: string;
  inputs: Record<string, unknown>;
}

export interface AgentResult {
  status: "success" | "failure";
  summary: string;
  artifacts?: string[];
  findings?: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  capabilities: string[];
  requiredPermissions: string[];
}
