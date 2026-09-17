import { requiresApproval } from "./policy";

export interface PermissionDecision {
  allowed: boolean;
  requiresApproval: boolean;
  deniedPermissions: string[];
}

/**
 * Project permission engine.
 *
 * Workspace and GitHub read/write access are enabled.
 * External/high-risk operations remain approval-gated by policy.
 */
export class PermissionEngine {
  private readonly allowedPermissions = new Set([
    "workspace.read",
    "workspace.write",
    "github.read",
    "github.write"
  ]);

  decide(required: string[]): PermissionDecision {
    const deniedPermissions = required.filter(
      (permission) => !this.allowedPermissions.has(permission)
    );
    const approvalRequired = required.some(
      (permission) =>
        this.allowedPermissions.has(permission) &&
        requiresApproval(permission)
    );

    return {
      allowed: deniedPermissions.length === 0 && !approvalRequired,
      requiresApproval: approvalRequired,
      deniedPermissions
    };
  }

  allowed(required: string[]): boolean {
    return this.decide(required).allowed;
  }
}
