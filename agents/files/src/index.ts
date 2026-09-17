import type { AgentDefinition } from "../../../packages/contracts/src/agent";

export const filesAgent: AgentDefinition = {
  id: "files",
  name: "Files Agent",
  capabilities: ["file.read", "file.search", "file.create", "file.validate"],
  requiredPermissions: ["workspace.read", "workspace.write"]
};
