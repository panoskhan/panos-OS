export type TaskStatus =
  | "received"
  | "understanding"
  | "planning"
  | "waiting_approval"
  | "executing"
  | "verifying"
  | "completed"
  | "failed";

export type RiskLevel = "read" | "low" | "external" | "high";

export interface Task {
  id: string;
  projectId: string;
  goal: string;
  status: TaskStatus;
  risk: RiskLevel;
  requiredAgents: string[];
  createdAt: string;
}
