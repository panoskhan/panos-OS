import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { KhanOrchestrator } from "../../../services/orchestrator/src/orchestrator";

const orchestrator = new KhanOrchestrator();
const PORT = Number(process.env.PORT ?? 3000);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>KHAN OS</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eef2ff;background:#050712}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% 5%,#18205a 0,#090d24 34%,#050712 72%);overflow-x:hidden}body:before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(#fff 1px,transparent 1px);background-size:46px 46px;opacity:.12}.shell{width:min(1180px,92vw);margin:auto;padding:28px 0 50px}.top{display:flex;justify-content:space-between;align-items:center;gap:20px}.brand{display:flex;align-items:center;gap:13px}.orb{width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff,#8d9cff 20%,#5c43e8 48%,#17132e 75%);box-shadow:0 0 35px #6b5cffaa}.brand h1{font-size:21px;letter-spacing:.2em;margin:0}.brand small{display:block;color:#8f9bbd;margin-top:3px}.status{border:1px solid #26315d;background:#0c1130cc;padding:9px 13px;border-radius:999px;color:#91f7c5;font-size:12px}.status i{display:inline-block;width:7px;height:7px;background:#55e6a1;border-radius:50%;margin-right:7px;box-shadow:0 0 12px #55e6a1}.hero{padding:70px 0 35px;text-align:center}.hero h2{font-size:clamp(38px,7vw,72px);line-height:.98;margin:0;background:linear-gradient(90deg,#fff,#b9c4ff 48%,#8c78ff);-webkit-background-clip:text;color:transparent}.hero p{max-width:680px;margin:18px auto;color:#a8b2d2;line-height:1.65}.panel{border:1px solid #232d55;background:#090e24dd;backdrop-filter:blur(18px);border-radius:24px;box-shadow:0 25px 80px #0008;padding:24px}.inputrow{display:flex;gap:10px}.inputrow input{flex:1;min-width:0;border:1px solid #2b3769;background:#050817;color:#fff;border-radius:14px;padding:15px 16px;font-size:15px;outline:none}.inputrow input:focus{border-color:#7164ff;box-shadow:0 0 0 3px #7164ff22}.btn{border:0;border-radius:14px;padding:0 20px;background:linear-gradient(135deg,#7164ff,#9a5cff);color:#fff;font-weight:700;cursor:pointer}.btn:disabled{opacity:.55;cursor:wait}.quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid #29345f;background:#0d1430;color:#aeb9dd;border-radius:999px;padding:7px 11px;font-size:12px;cursor:pointer}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin-top:18px}.sectiontitle{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;color:#dfe5ff}.sectiontitle span{font-size:12px;color:#7180aa}.steps{display:grid;gap:9px}.step{display:grid;grid-template-columns:28px 1fr auto;gap:12px;align-items:center;border:1px solid #202a50;background:#080d21;padding:12px;border-radius:14px}.num{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:#171d42;color:#9da8ff;font-size:12px}.step strong{font-size:13px}.step small{display:block;color:#6f7da7;margin-top:3px}.badge{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#78e6ba}.result{min-height:180px;color:#9eaacd;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow:auto;max-height:360px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.metric{padding:14px;border:1px solid #202a50;background:#080d21;border-radius:14px}.metric b{display:block;font-size:22px;color:#fff}.metric span{font-size:11px;color:#7180aa}.footer{text-align:center;color:#536083;font-size:11px;margin-top:24px}@media(max-width:760px){.top{align-items:flex-start}.grid{grid-template-columns:1fr}.inputrow{flex-direction:column}.btn{height:48px}.hero{padding-top:50px}.metrics{grid-template-columns:1fr}}
</style></head>
<body><main class="shell">
<header class="top"><div class="brand"><div class="orb"></div><div><h1>KHAN OS</h1><small>AI ORCHESTRATION CORE</small></div></div><div class="status"><i></i>CORE ONLINE</div></header>
<section class="hero"><h2>Understand. Plan. Act. Verify.</h2><p>Run the real KHAN OS orchestration core through a visual control surface. Every request becomes a task graph, passes dependency validation, executes through the agent runtime, and reaches independent QA.</p></section>
<section class="panel"><div class="inputrow"><input id="goal" value="Analyze this project and identify the next engineering tasks." /><button id="run" class="btn">Run KHAN</button></div><div class="quick"><button class="chip" data-goal="Analyze this project and identify the next engineering tasks.">Analysis</button><button class="chip" data-goal="Test the orchestration pipeline.">Testing</button><button class="chip" data-goal="Implement a safer approval flow.">Implementation</button></div></section>
<div class="grid"><section class="panel"><div class="sectiontitle"><b>Execution graph</b><span id="taskState">READY</span></div><div id="steps" class="steps"><div class="step"><div class="num">1</div><div><strong>Planner</strong><small>Waiting for a request</small></div><span class="badge">idle</span></div></div></section>
<section class="panel"><div class="sectiontitle"><b>System report</b><span>LIVE</span></div><div class="metrics"><div class="metric"><b id="stepCount">0</b><span>STEPS</span></div><div class="metric"><b id="qaState">—</b><span>QA</span></div><div class="metric"><b id="riskState">—</b><span>RISK</span></div></div><div id="result" class="result">Submit a goal to see the orchestration report.</div></section></div>
<div class="footer">KHAN OS · local development interface · no external credentials required</div></main>
<script>
const $=id=>document.getElementById(id);const goal=$("goal");
document.querySelectorAll(".chip").forEach(b=>b.onclick=()=>goal.value=b.dataset.goal);
function render(report){const steps=report.plan||[];$("stepCount").textContent=steps.length;$("qaState").textContent=report.verification?.passed?"PASS":"FAIL";$("riskState").textContent=report.task?.risk||"—";$("taskState").textContent=(report.task?.status||"UNKNOWN").toUpperCase();$("steps").innerHTML=steps.map((s,i)=>{const e=(report.execution||[]).find(x=>x.stepId===s.id);const state=e?.status||"planned";return '<div class="step"><div class="num">'+(i+1)+'</div><div><strong>'+s.title.replaceAll("<","&lt;")+'</strong><small>'+s.agent+' · '+s.permissions.join(", ")+'</small></div><span class="badge">'+state+'</span></div>'}).join("");$("result").textContent=JSON.stringify({task:report.task,verification:report.verification},null,2)}
$("run").onclick=async()=>{const value=goal.value.trim();if(!value)return;$("run").disabled=true;$("run").textContent="Running…";$("taskState").textContent="EXECUTING";try{const r=await fetch("/api/tasks",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({goal:value})});const data=await r.json();if(!r.ok)throw new Error(data.error||"Request failed");render(data)}catch(e){$("result").textContent="ERROR: "+e.message}finally{$("run").disabled=false;$("run").textContent="Run KHAN"}};
</script></body></html>`;

function json(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function createKhanWebServer() {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { status: "ok", service: "khan-os-web" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/tasks") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const goal = String(parsed.goal ?? "").trim();
          if (!goal) return json(res, 400, { error: "goal_required" });
          return json(res, 200, orchestrator.run(goal));
        } catch (error) {
          return json(res, 500, { error: "execution_failed", detail: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("apps/web/src/server.ts")) {
  createKhanWebServer().listen(PORT, "127.0.0.1", () => {
    console.log(`KHAN OS Web UI: http://127.0.0.1:${PORT}`);
  });
}
