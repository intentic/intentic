import { access } from "node:fs/promises";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { type IsolationPlan, isolationScript, nsenterArgv, startAnchor, type TurnIsolation } from "../../conversations/worktrees/isolation.js";
import { sandboxEnv } from "../../conversations/worktrees/turn-sandbox.js";
import { redirectCommand } from "../../conversations/worktrees/worktree-redirect.js";
import { runCheck } from "../../workload/run-check.js";

// A watch check runs in the world its arming turn saw: that turn's namespace rebuilt, or its paths rewritten likewise.

// A check killed at this deadline, in ms, is a failed check, not a stuck watch.
const CHECK_TIMEOUT_MS = 60_000;
// Characters of output a check reports, from the end.
const OUTPUT_TAIL = 3_000;
// Bytes captured per stream before capture stops.
const MAX_CAPTURE = 1024 * 1024;

// Printed once the namespace is up; absent from stdout means the namespace failed, not the check.
const CHECK_READY = "intentic-watch-check-ready";

/** An isolated conversation's worktree, whether its namespace is fenced, and to which folders. */
export interface WatchPlacement {
    readonly worktree: string;
    readonly fenced: boolean;
    // Absent on a watch armed before the folders were recorded: read as a fence naming nothing, the narrowest it could be.
    readonly fence?: readonly string[] | undefined;
}

export interface CheckResult {
    // Undefined when the check was killed at its deadline or never started.
    readonly exitCode: number | undefined;
    readonly output: string;
    // Why the check cannot run at all, which is never "still waiting".
    readonly broken?: string;
}

export interface CheckOptions {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly placement?: WatchPlacement;
}

export type RunCheck = (command: string, options: CheckOptions) => Promise<CheckResult>;

const tailOf = (stdout: string, stderr: string): string => `${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trim().slice(-OUTPUT_TAIL);

interface Spawned {
    readonly code: number | undefined;
    readonly stdout: string;
    readonly stderr: string;
    readonly failed?: string | undefined;
}

// Its own process group, so the deadline kills the check's whole tree, not just its shell; an agent's command in class.
const run = async (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<Spawned> => {
    const ran = await runCheck({
        argv,
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeoutMs: CHECK_TIMEOUT_MS,
        workload: { class: "command" },
        kind: "watch-check",
        captureBytes: MAX_CAPTURE,
    });
    return { code: ran.exitCode, stdout: ran.stdout, stderr: ran.stderr, failed: ran.spawnError };
};

const exists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

const plainCheck = async (command: string, options: CheckOptions): Promise<CheckResult> => {
    if (!(await exists(options.cwd))) {
        return { exitCode: undefined, output: "", broken: `the directory it runs in, ${options.cwd}, is gone` };
    }
    const done = await run(["bash", "-lc", command], options);
    return done.failed === undefined
        ? { exitCode: done.code, output: tailOf(done.stdout, done.stderr) }
        : { exitCode: undefined, output: tailOf(done.stdout, done.stderr), broken: `the check could not start: ${done.failed}` };
};

// The anchor's own script with the check as its trailer; the inherited PWD names the daemon's tree, so it is unset.
const namespacedCheck = async (command: string, options: CheckOptions, script: (trailer: string) => string, root: string): Promise<CheckResult> => {
    const trailer = [`echo ${CHECK_READY}`, `cd ${shellQuote(root)}`, `exec env -u PWD -u OLDPWD bash -lc ${shellQuote(command)}`].join("\n");
    const done = await run(["unshare", "--mount", "--propagation", "private", "sh", "-c", script(trailer)], { cwd: "/", env: options.env });
    const marker = done.stdout.indexOf(`${CHECK_READY}\n`);
    if (done.failed !== undefined || marker === -1) {
        return {
            exitCode: undefined,
            output: tailOf(done.stdout, done.stderr),
            broken: `its conversation's view of the workspace could not be rebuilt: ${done.failed ?? (done.stderr.trim() || `setup exited ${String(done.code)}`)}`,
        };
    }
    return { exitCode: done.code, output: tailOf(done.stdout.slice(marker + CHECK_READY.length + 1), done.stderr) };
};

// A fenced conversation's check runs where its turns do: in a sandbox of its own (turn-sandbox.ts), built for the one
// check and released after it. Never run open: a check that cannot have its sandbox is broken, not waiting.
const sandboxedCheck = async (command: string, options: CheckOptions, plan: IsolationPlan): Promise<CheckResult> => {
    let anchor: Awaited<ReturnType<typeof startAnchor>>;
    try {
        anchor = await startAnchor(plan);
    } catch (error) {
        return { exitCode: undefined, output: "", broken: `its conversation's sandbox could not be built: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
        const entry = nsenterArgv(anchor.pid, anchor.cwd, "bash", ["-lc", command]);
        const env = { ...options.env };
        if (anchor.sandbox !== undefined) {
            Object.assign(env, sandboxEnv(anchor.sandbox));
        }
        const done = await run([entry.command, ...entry.args], { cwd: "/", env });
        return done.failed === undefined
            ? { exitCode: done.code, output: tailOf(done.stdout, done.stderr) }
            : { exitCode: undefined, output: tailOf(done.stdout, done.stderr), broken: `the check could not start: ${done.failed}` };
    } finally {
        anchor.dispose();
    }
};

export const watchCheck =
    (isolation: TurnIsolation): RunCheck =>
    async (command, options) => {
        const placement = options.placement;
        if (placement === undefined) {
            return plainCheck(command, options);
        }
        if (!(await exists(placement.worktree))) {
            return { exitCode: undefined, output: "", broken: `its conversation's worktree, ${placement.worktree}, is gone` };
        }
        const plan = await isolation.planFor(placement.worktree, placement.fenced ? (placement.fence ?? []) : undefined);
        if (placement.fenced) {
            return (await isolation.sandboxAvailable())
                ? sandboxedCheck(command, options, plan)
                : { exitCode: undefined, output: "", broken: "its conversation is limited to some areas, and this sandbox cannot build the isolated environment that needs" };
        }
        if (await isolation.available()) {
            return namespacedCheck(command, options, (trailer) => isolationScript(plan, trailer), plan.root);
        }
        // Without a namespace the turn's Bash had its paths rewritten, so the check's are too.
        return plainCheck(redirectCommand(command, plan), { ...options, cwd: placement.worktree });
    };
