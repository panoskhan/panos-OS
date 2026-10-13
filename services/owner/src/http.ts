import type { IncomingMessage, ServerResponse } from "node:http";
import { OwnerError, OwnerWorkspace } from "./index";
import type { TaskStore } from "../../orchestrator/src/task-store";

export async function ownerRoute(req: IncomingMessage, res: ServerResponse, workspace: OwnerWorkspace, tasks: TaskStore) {
  const path = new URL(req.url ?? "/", "http://owner").pathname;
  const method = req.method;
  const send = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const body = async () => {
    let text = "";
    for await (const chunk of req) {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 1500000) throw new OwnerError(413, "Upload is too large.");
    }
    try { const value = JSON.parse(text || "{}"); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
    catch { throw new OwnerError(400, "Send a JSON object."); }
  };
  try {
    if (path === "/owner-api/overview" && method === "GET") return send(200, { ...workspace.overview(), tasks: tasks.all().map(t => t.report) });
    if (path === "/owner-api/model" && method === "PUT") return send(200, workspace.configure(await body()));
    if (path === "/owner-api/backup" && method === "GET") {
      res.setHeader("Content-Disposition", 'attachment; filename="panos-os-projects.json"');
      return send(200, workspace.backup());
    }
    if (path === "/owner-api/projects" && method === "POST") return send(201, workspace.create((await body()).name));
    const match = /^\/owner-api\/projects\/([a-f0-9-]+)(?:\/(files|suggestions))?$/.exec(path);
    if (match) {
      const [, id, action] = match;
      if (!action && method === "GET") return send(200, workspace.get(id));
      if (!action && method === "DELETE") { workspace.remove(id); return send(200, { deleted: true }); }
      if (action === "files" && method === "PUT") return send(200, workspace.upload(id, (await body()).files));
      if (action === "suggestions" && method === "POST") return send(200, await workspace.suggest(id, (await body()).goal));
    }
    return send(404, { error: "Route not found." });
  } catch (error) {
    return send(error instanceof OwnerError ? error.status : 500, { error: error instanceof OwnerError ? error.message : "Owner operation failed. Check storage availability." });
  }
}
