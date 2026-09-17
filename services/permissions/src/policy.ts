export type PermissionRisk = "read" | "low" | "external" | "high";

export interface PermissionPolicy {
  permission: string;
  risk: PermissionRisk;
  requiresApproval: boolean;
}

export const defaultPolicies: PermissionPolicy[] = [
  { permission: "workspace.read", risk: "read", requiresApproval: false },
  { permission: "workspace.write", risk: "low", requiresApproval: false },
  { permission: "github.read", risk: "read", requiresApproval: false },
  { permission: "github.write", risk: "external", requiresApproval: true },
  { permission: "publish.external", risk: "external", requiresApproval: true },
  { permission: "destructive.action", risk: "high", requiresApproval: true }
];

export function requiresApproval(permission: string): boolean {
  return defaultPolicies.find((policy) => policy.permission === permission)?.requiresApproval ?? true;
}
