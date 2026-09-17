import { KhanOrchestrator } from "../../../services/orchestrator/src/orchestrator";

const goal = process.argv.slice(2).join(" ").trim() || "Analyze this project and identify the next engineering tasks.";
const orchestrator = new KhanOrchestrator();
const report = orchestrator.run(goal);

console.log(JSON.stringify(report, null, 2));
