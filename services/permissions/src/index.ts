import { requiresApproval } from "./policy";

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  deniedPermissions: string[];
}

export class PermissionEngine {
  private readonly allowedPermissions = new Set(["workspace.read"]);

  decide(required: string[]): PermissionDecision {
    const deniedPermissions = required.filter((permission) => !this.allowedPermissions.has(permission));
    return {
      allowed: deniedPermissions.length === 0,
      requiresApproval: deniedPermissions.some(requiresApproval),
      deniedPermissions
    };
  }

  allowed(required: string[]): boolean {
    return this.decide(required).allowed;
  }
}
