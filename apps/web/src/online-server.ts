import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { createKhanApiServer } from "../../api/src/index";
import { KhanOrchestrator } from "../../../services/orchestrator/src/orchestrator";
import { AuditLog, FileAuditSink } from "../../../services/audit/src/index";
import { ApiKeyAuth } from "../../../services/auth/src/index";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2"
};
const digest = (value: string) => createHash("sha256").update(value).digest();

export function createOnlineServer(password: string, root = resolve("apps/web/dist"), publicDemo = false) {
  if (password.length < 16) throw new Error("SITE_PASSWORD must contain at least 16 characters.");
  if (!existsSync(resolve(root, "index.html"))) throw new Error("Build the web app before starting the online server.");
  const expected = digest(`panos:${password}`);
  const audit = new AuditLog(new FileAuditSink(process.env.KHAN_AUDIT_FILE ?? "data/audit.jsonl"));
  const orchestrator = new KhanOrchestrator(undefined, undefined, undefined, undefined, audit);
  // Every API request passes the site's authentication gate first. No key is shipped in browser assets.
  const api = createKhanApiServer(orchestrator, { auth: ApiKeyAuth.disabled() });
  const site = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://site").pathname); }
    catch { res.writeHead(400).end(); return; }
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", service: "panos-os-online" }));
      return;
    }
    const header = req.headers.authorization ?? "";
    const credential = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString("utf8") : "";
    const authenticated = timingSafeEqual(digest(credential), expected);
    const publicApi = (req.method === "GET" && (pathname === "/v1/status" || /^\/v1\/tasks\/[^/]+(?:\/events)?$/.test(pathname)))
      || (req.method === "POST" && pathname === "/v1/tasks");
    const apiPath = pathname === "/v1" || pathname.startsWith("/v1/");
    if (publicDemo && !authenticated && pathname === "/v1/ghost" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ghosts":[]}');
      return;
    }
    if (publicDemo && !authenticated && apiPath && !publicApi) {
      res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"demo_restricted","detail":"This action is available only to the site owner."}');
      return;
    }
    if (!authenticated && !publicDemo) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Panos OS", charset="UTF-8"' }).end("Sign in with username panos.");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET") && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) { res.writeHead(403).end(); return; }
      } catch { res.writeHead(403).end(); return; }
    }
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      api.emit("request", req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
    const file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const target = existsSync(file) && statSync(file).isFile() ? file : extname(pathname) ? undefined : resolve(root, "index.html");
    if (!target) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
    if (req.method === "HEAD") { res.end(); return; }
    const stream = createReadStream(target);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
  return site;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("apps/web/src/online-server.ts")) {
  const server = createOnlineServer(process.env.SITE_PASSWORD ?? "", undefined, process.env.PUBLIC_DEMO === "true");
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, "0.0.0.0", () => console.log(`Panos OS online server listening on port ${port}`));
}
