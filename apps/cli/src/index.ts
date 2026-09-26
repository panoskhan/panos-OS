import { KhanOrchestrator } from "../../../services/orchestrator/src/orchestrator";

async function main() {
  const goal = process.argv.slice(2).join(" ").trim() || "Analyze this project and identify the next engineering tasks.";
  const orchestrator = new KhanOrchestrator();
  const report = await orchestrator.run(goal);

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
