import { access } from "node:fs/promises";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { isolationScript, type TurnIsolation } from "../../conversations/worktrees/isolation.js";
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

/** An isolated conversation's worktree and whether its namespace is fenced. */
export interface WatchPlacement {
    readonly worktree: string;
    readonly fenced: boolean;
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
        const plan = await isolation.planFor(placement.worktree, placement.fenced);
        if (await isolation.available()) {
            return namespacedCheck(command, options, (trailer) => isolationScript(plan, trailer), plan.root);
        }
        // Without a namespace the turn's Bash had its paths rewritten, so the check's are too.
        return plainCheck(redirectCommand(command, plan), { ...options, cwd: placement.worktree });
    };
