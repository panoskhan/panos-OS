export class PermissionEngine {
  private readonly allowedPermissions = new Set(["workspace.read"]);

  allowed(required: string[]): boolean {
    return required.every((permission) => this.allowedPermissions.has(permission));
  }
}
