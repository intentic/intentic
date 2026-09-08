import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { whenAborted } from "../abort.js";
import type { TurnPlacement } from "../agents/worktrees/isolation.js";
import { inWorktree, nsenterArgv } from "../agents/worktrees/isolation.js";
import type { TurnPersona } from "../personas/personas.js";
import { resolveWithin } from "../workspace/files/workspace-files-paths.js";

// Second way a turn runs code, beside the shell; Node's permission model makes the read/write/spawn fence real rather
// than advisory, gated per persona power. Network is the one ungated hole: `fetch` always works whatever the persona's
// grant. Runs as the daemon's child, not the agent's, so escaping via child_process still needs `shell`.

// Resolved at plan time from the persona's card, carried as `jsExecution` on the request rather than the tool-server
// bag. Paths are the agent's view; placedPlan maps them to the subprocess's actual location.
export interface JsExecutionPlan {
    // Where the script runs: the persona's start folder when the card names one, else the turn's root.
    readonly cwd: string;
    // Same environment the shell gets: persona-filtered connector credentials, the extension PATH.
    readonly env: Readonly<Record<string, string>>;
    // Directory roots reads are granted under; empty means no filesystem at all (persona files "none").
    readonly readRoots: readonly string[];
    // Directory roots writes are granted under; empty means nothing on disk changes (persona files "read"/"none").
    readonly writeRoots: readonly string[];
    // Whether the script may start other programs; granted only with `shell`.
    readonly allowSpawn: boolean;
}

// Undefined when this turn has no JS backend: absence, not mounted-and-refused. Folders resolve like the file-tool
// fence, an escaping one dropped; tmpdir is readable whenever anything is, writable only with full file power.
export const jsExecutionPlanOf = (
    persona: TurnPersona,
    // The turn's root (folders resolve against it) and the cwd scripts actually run in (the persona's start folder).
    tree: { readonly root: string; readonly cwd: string },
    env: Readonly<Record<string, string>>,
): JsExecutionPlan | undefined => {
    const powers = persona.powers;
    if (!powers.code) {
        return undefined;
    }
    const folders = (persona.workspace?.folders ?? [])
        .map((folder) => resolveWithin(tree.root, folder))
        .filter((folder): folder is string => folder !== undefined);
    const roots = folders.length === 0 ? [tree.root] : folders;
    return {
        cwd: tree.cwd,
        env,
        readRoots: powers.files === "none" ? [] : [...roots, tmpdir()],
        writeRoots: powers.files === "write" ? roots : [],
        allowSpawn: powers.shell,
    };
};

// Mirrors the Bash tool's own bounds: the default a script gets, and the most it may ask for.
export const JS_TIMEOUT_DEFAULT_S = 120;
export const JS_TIMEOUT_MAX_S = 600;
// Tail-kept output per stream, and the hard stop that kills a run flooding its pipes.
const OUTPUT_TAIL = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface JsRunResult {
    // Undefined when the run didn't exit on its own: killed at the timeout, on turn abort, or drowned in output.
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

// `--input-type=module -` reads the script from stdin, so a filesystem-less plan needs no read grant to load its own
// code. The --allow-child-process SecurityWarning is suppressed: it targets whoever chose the flags, not the model.
export const nodeArgs = (plan: Pick<JsExecutionPlan, "readRoots" | "writeRoots" | "allowSpawn">): string[] => [
    "--permission",
    ...plan.readRoots.map((root) => `--allow-fs-read=${root}`),
    ...plan.writeRoots.map((root) => `--allow-fs-write=${root}`),
    ...(plan.allowSpawn ? ["--allow-child-process", "--disable-warning=SecurityWarning"] : []),
    "--input-type=module",
    "-",
];

// Anchored turns enter the daemon's child via nsenter with paths unchanged; an unanchored isolated turn has no
// namespace to enter, so paths are mapped into its worktree tree instead. A main-tree turn needs neither.
const placedPlan = (plan: JsExecutionPlan, placement: TurnPlacement | undefined): JsExecutionPlan => {
    if (placement === undefined || placement.anchor !== undefined) {
        return plan;
    }
    return {
        ...plan,
        cwd: inWorktree(plan.cwd, placement.plan),
        readRoots: plan.readRoots.map((root) => inWorktree(root, placement.plan)),
        writeRoots: plan.writeRoots.map((root) => inWorktree(root, placement.plan)),
    };
};

// Resolves on every road, exit, timeout, spawn failure, turn abort, so a script's own bug fails the tool call, not the
// turn. Killed with SIGKILL: the script is unattended, and a runaway ignoring SIGTERM would outlive the turn.
export const runJs = (
    plan: JsExecutionPlan,
    code: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal; readonly placement: TurnPlacement | undefined },
): Promise<JsRunResult> =>
    new Promise((resolve) => {
        const placed = placedPlan(plan, options.placement);
        const anchor = options.placement?.anchor;
        const invocation =
            anchor === undefined ? { command: "node", args: nodeArgs(placed) } : nsenterArgv(anchor.pid, placed.cwd, "node", nodeArgs(placed));
        // Same environment the agent's shell gets: the container's, plus the turn's persona-filtered credentials.
        const child = spawn(invocation.command, invocation.args, {
            ...(anchor === undefined ? { cwd: placed.cwd } : {}),
            env: { ...process.env, ...placed.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const settle = (exitCode: number | undefined): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            unwatchAbort();
            resolve({ exitCode, timedOut, stdout: stdout.slice(-OUTPUT_TAIL), stderr: stderr.slice(-OUTPUT_TAIL) });
        };
        const kill = (): void => {
            child.kill("SIGKILL");
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, options.timeoutMs);
        // A turn already aborted when this script's card arrives would otherwise run the full timeout after the Stop.
        const unwatchAbort = whenAborted(options.signal, kill);
        child.stdout.on("data", (data: Buffer) => {
            stdout += data.toString();
            if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
                kill();
            }
        });
        child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
            if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
                kill();
            }
        });
        child.on("error", (error) => {
            stderr += `${stderr === "" ? "" : "\n"}${error.message}`;
            settle(undefined);
        });
        child.on("close", (exitCode) => {
            settle(exitCode ?? undefined);
        });
        child.stdin.on("error", () => {
            // A child that dies before reading its script closes stdin under the write; `close` reports the real story.
        });
        child.stdin.end(code);
    });
