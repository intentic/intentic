import { tmpdir } from "node:os";
import type { TurnPlacement } from "../conversations/worktrees/isolation.js";
import { namespaceTargetOf, nsenterArgv } from "../workload/namespace-entry.js";
import { inWorktree } from "../workload/worktree-paths.js";
import type { TurnPersona } from "../personas/personas.js";
import { runCheck } from "../workload/run-check.js";
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
    const folders = (persona.fence ?? [])
        .map((folder) => resolveWithin(tree.root, folder))
        .filter((folder): folder is string => folder !== undefined);
    // Undefined fence is the whole tree; a fence that resolved to nothing is a real answer and stays empty, or a
    // member fenced to a folder this checkout doesn't hold would get the workspace root instead.
    const roots = persona.fence === undefined ? [tree.root] : folders;
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
// Tail-kept output per stream, and the hard stop (per stream) that kills a run flooding its pipes.
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

// Anchored turns enter the daemon's child via nsenter with paths unchanged; an uncheckpointed isolated turn has no
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
// turn. Its whole process group is ended, SIGKILL after a grace: the script is unattended, and a runaway ignoring
// SIGTERM, or a child it started, would otherwise outlive the turn.
export const runJs = async (
    plan: JsExecutionPlan,
    code: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal; readonly placement: TurnPlacement | undefined },
): Promise<JsRunResult> => {
    const placed = placedPlan(plan, options.placement);
    const anchor = options.placement?.anchor;
    const invocation =
        anchor === undefined ? { command: "node", args: nodeArgs(placed) } : nsenterArgv(namespaceTargetOf(anchor), placed.cwd, "node", nodeArgs(placed));
    const ran = await runCheck({
        argv: [invocation.command, ...invocation.args],
        ...(anchor === undefined ? { cwd: placed.cwd } : {}),
        // Same environment the agent's shell gets: the container's, plus the turn's persona-filtered credentials.
        env: { ...process.env, ...placed.env },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        workload: { class: "command" },
        kind: "js-run",
        // The hard stop that kills a run flooding its pipes; what comes back is the tail of each.
        captureBytes: MAX_OUTPUT_BYTES,
        keep: "tail",
        killOnOverflow: true,
        stdin: code,
    });
    const stderr = ran.spawnError === undefined ? ran.stderr : `${ran.stderr}${ran.stderr === "" ? "" : "\n"}${ran.spawnError}`;
    return {
        exitCode: ran.exitCode,
        timedOut: ran.ended === "timeout",
        stdout: ran.stdout.slice(-OUTPUT_TAIL),
        stderr: stderr.slice(-OUTPUT_TAIL),
    };
};
