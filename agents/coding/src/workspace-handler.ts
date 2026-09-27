import type { AgentResult } from "../../../packages/contracts/src/agent";
import type { AgentHandler } from "../../../services/agents/src/runtime";
import { WorkspaceError, type CommandResult, type Workspace } from "../../../services/workspace/src/index";
import type { ChatModel } from "./model-handler";

/** Where a task's workspace comes from (the real WorkspaceManager, or a fake in tests). */
export interface WorkspaceProvider {
  forTask(taskId: string): Workspace;
}

export const DEFAULT_MAX_TURNS = 12;
const MAX_FINDINGS = 8;
const MAX_FINDING_LENGTH = 400;
const MAX_TOOL_REPLY = 6_000;
const MAX_LIST_ENTRIES = 200;

const trim = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** The first complete JSON object in a model reply (models wrap them in prose or code fences), or null. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (char === "\\") i++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch {
          /* not JSON: try the next brace */
        }
        break;
      }
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are the coding agent of KHAN OS. You work inside a sandboxed copy of the project. You act by replying with EXACTLY ONE JSON object per message and nothing else. The tools:
{"tool":"list_dir","path":"."}                      list a folder (folders end with /)
{"tool":"read_file","path":"src/a.ts"}              read a text file
{"tool":"write_file","path":"src/a.ts","content":"..."}   create or replace a file with the FULL new content (only when this step allows writing)
{"tool":"run","command":"test"}                     run a fixed command; allowed: test, build
{"tool":"finish","findings":["short line","short line"]}   end the step with 3 to 6 short factual findings
Rules: paths are relative to the project root; you cannot reach anything outside it. Look at real files before you claim anything about them, and say only what you actually saw or did. Finish as soon as the step is done.`;

function describe(command: CommandResult): string {
  const outcome = command.timedOut ? "TIMED OUT" : command.exitCode === 0 ? "passed" : "FAILED";
  return `Ran ${command.name}: ${outcome} (exit ${command.exitCode ?? "none"}, ${command.durationMs}ms)`;
}

function asFindings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_FINDINGS)
    .map((item) => trim(item, MAX_FINDING_LENGTH));
}

/**
 * A coding agent that works in a real sandbox: it can list, read and (when the step allows it) write files in its task's
 * workspace copy and run the fixed `test` and `build` commands. The findings start with facts the harness measured
 * itself (files read and written, command results), so QA and the reader never have to trust the model's claims about them.
 * Nothing is applied to the real project.
 */
export function createWorkspaceCodingHandler(
  model: ChatModel,
  workspaces: WorkspaceProvider,
  { maxTurns = DEFAULT_MAX_TURNS }: { maxTurns?: number } = {}
): AgentHandler {
  return async (step, context): Promise<AgentResult> => {
    const workspace = workspaces.forTask(context.taskId);
    const canWrite = step.permissions.includes("workspace.write");
    const earlier = ((context.inputs.agentResults as AgentResult[] | undefined) ?? []).map((result) => `- ${result.summary}`).join("\n");

    const read = new Set<string>();
    const written = new Map<string, number>();
    const commands: CommandResult[] = [];
    let modelFindings: string[] = [];

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Goal: ${context.goal}`,
          `Current step (${step.id}): ${step.title}`,
          canWrite ? "This step MAY write files." : "This step may NOT write files.",
          step.id === "test" ? "This step must run the tests." : "",
          earlier ? `Earlier steps:\n${earlier}` : ""
        ].filter(Boolean).join("\n\n")
      }
    ];

    const useTool = async (call: Record<string, unknown>): Promise<string> => {
      switch (call.tool) {
        case "list_dir":
          return workspace.list(call.path ?? ".").slice(0, MAX_LIST_ENTRIES).join("\n") || "(empty)";
        case "read_file": {
          const file = workspace.read(call.path);
          read.add(String(call.path));
          return file.truncated ? `${file.content}\n[truncated]` : file.content;
        }
        case "write_file": {
          if (!canWrite) throw new WorkspaceError("Writing is not allowed in this step");
          written.set(String(call.path), workspace.write(call.path, call.content));
          return `Wrote ${String(call.path)}`;
        }
        case "run": {
          const result = await workspace.run(call.command);
          commands.push(result);
          return `${describe(result)}\n${result.output}`;
        }
        default:
          throw new WorkspaceError(`Unknown tool '${String(call.tool)}'`);
      }
    };

    let finished = false;
    for (let turn = 1; turn <= maxTurns && !finished; turn++) {
      const { text } = await model.chat(messages);
      messages.push({ role: "assistant", content: text });

      const call = extractJsonObject(text);
      if (!call || typeof call.tool !== "string") {
        messages.push({ role: "user", content: 'Reply with exactly one JSON object, for example {"tool":"list_dir","path":"."}.' });
        continue;
      }
      if (call.tool === "finish") {
        modelFindings = asFindings(call.findings);
        finished = true;
        break;
      }
      try {
        messages.push({ role: "user", content: trim(await useTool(call), MAX_TOOL_REPLY) });
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        messages.push({ role: "user", content: `Error: ${error.message}` });
      }
    }
    if (!finished) throw new Error(`The model did not finish step '${step.id}' within ${maxTurns} turns`);

    // The test step always ends with a real test run, even if the model forgot to ask for one.
    if (step.id === "test" && !commands.some((command) => command.name === "test")) commands.push(await workspace.run("test"));

    const testsFailed = step.id === "test" && commands.some((command) => command.name === "test" && (command.exitCode !== 0 || command.timedOut));
    const facts = [
      `Worked in a sandbox copy: ${workspace.root}. The real project was not changed.`,
      ...(read.size ? [`Read ${read.size} file(s): ${trim([...read].join(", "), 300)}`] : []),
      ...[...written].map(([path, bytes]) => `Wrote ${path} (${bytes} bytes)`),
      ...commands.map(describe),
      ...(testsFailed ? [`Last test output: ${trim(commands.filter((command) => command.name === "test").at(-1)!.output.trim().slice(-300), 300)}`] : [])
    ];
    return {
      status: testsFailed ? "failure" : "success",
      // QA checks that every result mentions the goal, so the summary always does.
      summary: `${testsFailed ? "Tests failed in" : "Executed"} coding agent step '${step.id}' for goal: ${context.goal}`,
      artifacts: [...written.keys()],
      findings: [...facts, ...modelFindings.map((finding) => `Model: ${finding}`)]
    };
  };
}
