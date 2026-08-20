import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { TurnPlacement } from "../agents/isolation.js";
import { inWorktree, nsenterArgv } from "../agents/isolation.js";
import type { TurnPersona } from "../personas/personas.js";
import { resolveWithin } from "../workspace/workspace-files.js";

/* THE JS EXECUTION BACKEND, the second way a turn runs work of its own, beside the shell
 * (AgentCapabilities.execution in the contract).
 *
 * The model writes a script instead of a command line: an ESM module, top-level await allowed, run by the
 * Node on this image in a subprocess under Node's permission model. That model is what makes this backend
 * different in kind from Bash, not merely in syntax, the fence around it is REAL where the shell's is
 * advisory:
 *
 *   - reads and writes are granted per directory root, derived from the persona's `files` answer and its
 *     folder scope, where the file-tool hooks can only refuse the paths they are shown, this refuses the
 *     open() itself, whatever computed the path;
 *   - starting other programs is granted only when the persona also holds `shell`, so a card reading
 *     "code yes, commands no" cannot become a shell through child_process;
 *   - workers, native addons, WASI and the inspector are never granted.
 *
 * ONE STATED GAP, said here and in the tool's own description: Node's permission model does not gate the
 * network, so `fetch` works whenever the backend is mounted at all, the `web` shelf cannot be cut inside a
 * script. The same register as the folder fence's own caveat: a limit that is weaker than it looks is worse
 * than no limit, so the weakness is named where the limit is set.
 *
 * DAEMON-SIDE ON PURPOSE. The subprocess is the daemon's child, not the agent process's, which is what lets
 * the daemon own the flags, a runner inside the agent's own shell would be a Bash command wearing a costume,
 * and would vanish exactly when the persona takes Bash away. The price is that the daemon must stand in the
 * turn's view of the files itself: entered with nsenter for an anchored turn, mapped into the worktree for an
 * unanchored isolated one (placedPlan below), the same discipline the diagnostics checker uses. */

/* What one turn's JS runs are allowed, resolved at plan time from the persona's card and carried on the
 * request as a first-class field (AgentRequest.jsExecution), a peer of `cliEnv` and `isolation`, deliberately
 * NOT an entry in the generic tool-server bag, so the backend exists for every layer that plans, serves or
 * explains a turn rather than only for the loop that happens to mount it.
 *
 * Paths here speak the AGENT'S view of the tree (they were resolved against the turn's effective cwd);
 * placedPlan translates them into wherever the subprocess actually stands. */
export interface JsExecutionPlan {
    // Where the script runs, the persona's start folder when the card names one, else the turn's root.
    readonly cwd: string;
    // The same environment the shell gets: persona-filtered connector credentials, the extension PATH.
    readonly env: Readonly<Record<string, string>>;
    // Directory roots reads are granted under. Empty ⇒ no filesystem at all (persona files "none").
    readonly readRoots: readonly string[];
    // Directory roots writes are granted under. Empty ⇒ nothing on disk changes (persona files "read"/"none").
    readonly writeRoots: readonly string[];
    // Whether the script may start other programs, granted only with `shell`, see the header.
    readonly allowSpawn: boolean;
}

/* The plan a persona's card yields, or undefined when this turn has no JS backend at all, the same
 * enforcement-by-absence the account filter uses: an ungranted backend is never mounted, not mounted-and-
 * refused. Called where the one request every runtime builds on is assembled (turn-plan's honoured), gated
 * there on the runtime actually hosting "js".
 *
 * The folder scope is the card's own `folders`, resolved exactly as the file-tool fence resolves them and with
 * the same typo posture: a folder that escapes the workspace is DROPPED, leaving the root grant, rather than
 * refusing every run at 3am for a card mistake the work was never going to touch. tmpdir is readable whenever
 * anything is, attachments and scratch files live there, but writable only with full file power. */
export const jsExecutionPlanOf = (
    persona: TurnPersona,
    // The turn's root (folders resolve against it, the same anchoring the file-tool fence uses) and the
    // directory scripts actually run in, which is the persona's start folder when the card names one.
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
// Tail-kept output per stream, and the hard stop that kills a run flooding its pipes, the same caps
// discipline the watch checks use, sized for a tool result the model actually reads.
const OUTPUT_TAIL = 30_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface JsRunResult {
    // Undefined when the run did not exit on its own: killed at the timeout, on turn abort, or drowned.
    readonly exitCode: number | undefined;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

/* The node argv a plan means, exported bare so the tests can pin flags to powers without spawning anything.
 * `--input-type=module -` reads the script from stdin, no temp file, so a filesystem-less plan (files "none")
 * needs no read grant just to load its own code. The SecurityWarning Node prints for --allow-child-process is
 * suppressed: it is addressed to the person choosing the flags, and that person is this file, not the model
 * reading stderr. */
export const nodeArgs = (plan: Pick<JsExecutionPlan, "readRoots" | "writeRoots" | "allowSpawn">): string[] => [
    "--permission",
    ...plan.readRoots.map((root) => `--allow-fs-read=${root}`),
    ...plan.writeRoots.map((root) => `--allow-fs-write=${root}`),
    ...(plan.allowSpawn ? ["--allow-child-process", "--disable-warning=SecurityWarning"] : []),
    "--input-type=module",
    "-",
];

/* The plan translated to where the subprocess will actually stand. The plan's paths speak the agent's view;
 * the daemon's child sees that view only inside an anchored turn's namespace, entered with nsenter, paths
 * unchanged. An unanchored isolated turn has no namespace to enter, so the daemon-side worktree paths are the
 * turn's tree and every path is mapped into them (the same translation worktree-redirect performs on tool
 * inputs). A main-tree turn needs neither. */
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

/* Run one script. Resolves on every road, exit, timeout, spawn failure, turn abort, because a tool call
 * that rejects turns a script's own bug into a failed TURN; the result carries what the model needs to fix
 * its script instead. Killed with SIGKILL rather than asked: the script is unattended code, there is nothing
 * to hand a graceful signal to, and a runaway that ignores SIGTERM would outlive the turn that started it. */
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
        // The same environment assembly the agent's own shell gets (agent.ts `env`): the container's, with the
        // turn's persona-filtered credentials over it.
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
            options.signal.removeEventListener("abort", kill);
            resolve({ exitCode, timedOut, stdout: stdout.slice(-OUTPUT_TAIL), stderr: stderr.slice(-OUTPUT_TAIL) });
        };
        const kill = (): void => {
            child.kill("SIGKILL");
        };
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, options.timeoutMs);
        options.signal.addEventListener("abort", kill, { once: true });
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
            // A child that dies before reading its script closes stdin under the write; `close` carries the story.
        });
        child.stdin.end(code);
    });
