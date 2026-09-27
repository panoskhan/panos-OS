import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceCommand {
  file: string;
  args: string[];
}

/** The only things the model may run. Each is a fixed command line: the model picks a name, never the arguments. */
export const DEFAULT_COMMANDS: Record<string, WorkspaceCommand> = {
  test: {
    file: process.execPath,
    args: ["--env-file=tests/test.env", "--experimental-eventsource", "--import", "tsx", "--test", "tests/**/*.test.ts"]
  },
  build: { file: process.execPath, args: ["node_modules/typescript/bin/tsc", "--noEmit"] }
};

export interface CommandResult {
  name: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The end of the combined stdout and stderr. */
  output: string;
  durationMs: number;
}

export const MAX_READ_BYTES = 20_000;
export const MAX_WRITE_BYTES = 100_000;
const OUTPUT_TAIL = 4_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Never copied into a workspace and never readable or writable through it. Secrets live in `.env*`. */
const BLOCKED = /^(node_modules|\.git|\.claude|data)$|^\.env/;
/** Copied into nothing: build output is regenerated, and `.git` history is not the model's business. */
const NOT_COPIED = /^(node_modules|\.git|\.claude|data|dist)$|^\.env/;

/** What a command gets to see. In particular no API keys: it runs code the model may have just written. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "ComSpec"];
  return Object.fromEntries(keep.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
}

/** A folder the model may read, edit and run tests in. Nothing outside it can be reached through this class. */
export class Workspace {
  constructor(
    readonly root: string,
    private readonly commands: Record<string, WorkspaceCommand> = DEFAULT_COMMANDS,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  commandNames(): string[] {
    return Object.keys(this.commands);
  }

  /** Turns a model-supplied relative path into a real one inside the workspace, or throws. */
  resolve(path: unknown): string {
    if (typeof path !== "string" || !path.trim()) throw new WorkspaceError("A path is required");
    if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) throw new WorkspaceError(`Paths must be relative to the workspace: ${path}`);
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new WorkspaceError(`Path is outside the workspace: ${path}`);
    if (rel.split(sep).some((segment) => BLOCKED.test(segment))) throw new WorkspaceError(`Path is not accessible: ${path}`);

    // A link inside the workspace must not lead out of it: check where the nearest existing part really points.
    let existing = full;
    while (!existsSync(existing)) existing = dirname(existing);
    const real = relative(realpathSync(this.root), realpathSync(existing));
    if (real.startsWith("..") || isAbsolute(real)) throw new WorkspaceError(`Path leads outside the workspace: ${path}`);
    return full;
  }

  /** Names in a folder, folders marked with a trailing slash. */
  list(path: unknown = "."): string[] {
    const full = this.resolve(path);
    if (!statSync(full, { throwIfNoEntry: false })?.isDirectory()) throw new WorkspaceError(`Not a folder: ${String(path)}`);
    return readdirSync(full, { withFileTypes: true })
      .filter((entry) => !BLOCKED.test(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
  }

  read(path: unknown): { content: string; truncated: boolean } {
    const full = this.resolve(path);
    if (!statSync(full, { throwIfNoEntry: false })?.isFile()) throw new WorkspaceError(`Not a file: ${String(path)}`);
    const bytes = readFileSync(full);
    const truncated = bytes.length > MAX_READ_BYTES;
    // Shown with "\n" line endings whatever the file uses, so what the model copies back into an edit matches (see `edit`).
    return { content: bytes.subarray(0, MAX_READ_BYTES).toString("utf8").replace(/\r\n/g, "\n"), truncated };
  }

  /** Writes (or replaces) a text file, creating folders as needed. Returns the size written. */
  write(path: unknown, content: unknown): number {
    if (typeof content !== "string") throw new WorkspaceError("content must be text");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_WRITE_BYTES) throw new WorkspaceError(`File is too large to write (${bytes} bytes, limit ${MAX_WRITE_BYTES})`);
    const full = this.resolve(path);
    if (existsSync(full) && !statSync(full).isFile()) throw new WorkspaceError(`Not a file: ${String(path)}`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return bytes;
  }

  /** Replaces one exact piece of text in a file. The text must occur exactly once, so an edit can never land in the wrong place. */
  edit(path: unknown, find: unknown, replacement: unknown): number {
    if (typeof find !== "string" || !find) throw new WorkspaceError("find must be the exact, non-empty text to replace");
    if (typeof replacement !== "string") throw new WorkspaceError("replace must be text");
    const full = this.resolve(path);
    if (!statSync(full, { throwIfNoEntry: false })?.isFile()) throw new WorkspaceError(`Not a file: ${String(path)}`);

    const original = readFileSync(full, "utf8");
    // The model sees and writes "\n". A file that uses Windows line endings is matched, and edited, in its own style.
    const crlf = original.includes("\r\n");
    const toFileStyle = (text: string) => (crlf ? text.replace(/\r?\n/g, "\r\n") : text);
    const target = toFileStyle(find);
    const insert = toFileStyle(replacement);
    const occurrences = original.split(target).length - 1;
    if (occurrences !== 1) {
      throw new WorkspaceError(
        occurrences === 0
          ? `The text to replace was not found in ${String(path)}. It must match exactly, including whitespace.`
          : `The text to replace occurs ${occurrences} times in ${String(path)}. Include more surrounding text so it is unique.`
      );
    }
    const updated = original.replace(target, () => insert);
    return this.write(path, updated);
  }

  run(name: unknown): Promise<CommandResult> {
    const command = typeof name === "string" ? this.commands[name] : undefined;
    if (!command || typeof name !== "string") {
      return Promise.reject(new WorkspaceError(`Unknown command '${String(name)}'. Allowed: ${this.commandNames().join(", ")}`));
    }
    return new Promise((resolvePromise) => {
      const started = Date.now();
      let output = "";
      let timedOut = false;
      const child = spawn(command.file, command.args, { cwd: this.root, env: scrubbedEnv(), shell: false, windowsHide: true });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, this.timeoutMs);
      const collect = (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 4);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const done = (exitCode: number | null, extra = "") => {
        clearTimeout(timer);
        resolvePromise({ name, exitCode, timedOut, output: (output + extra).slice(-OUTPUT_TAIL), durationMs: Date.now() - started });
      };
      child.on("error", (error) => done(null, `\n[could not start: ${error.message}]`));
      child.on("close", (code) => done(code, timedOut ? `\n[stopped after ${this.timeoutMs}ms]` : ""));
    });
  }
}

/**
 * Copies a project folder, leaving out secrets, dependencies, history, build output and links.
 * Not `fs.cpSync`, which refuses to copy a folder into a subfolder of itself, and workspaces live in the project's `data/`.
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (NOT_COPIED.test(entry.name) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

export interface WorkspaceManagerOptions {
  /** The project folder each workspace is copied from. It is never modified. */
  source: string;
  /** Where workspaces are created: one folder per task. */
  base: string;
  commands?: Record<string, WorkspaceCommand>;
  timeoutMs?: number;
}

/** Gives each task its own workspace: a copy of the project without secrets, dependencies or history. */
export class WorkspaceManager {
  private readonly made = new Map<string, Workspace>();

  constructor(private readonly options: WorkspaceManagerOptions) {}

  get base(): string {
    return this.options.base;
  }

  forTask(taskId: string): Workspace {
    const existing = this.made.get(taskId);
    if (existing) return existing;
    if (!/^[\w-]+$/.test(taskId)) throw new WorkspaceError(`Invalid task id for a workspace: ${taskId}`);

    const { source, base } = this.options;
    const root = join(base, taskId);
    if (!existsSync(root)) {
      copyTree(source, root);
      // Dependencies are shared, not copied. The model cannot reach them: their name is blocked in every path.
      const modules = join(source, "node_modules");
      if (existsSync(modules)) symlinkSync(modules, join(root, "node_modules"), "junction");
    }
    const workspace = new Workspace(root, this.options.commands, this.options.timeoutMs);
    this.made.set(taskId, workspace);
    return workspace;
  }
}
