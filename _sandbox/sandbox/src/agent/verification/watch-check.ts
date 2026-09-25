import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { isolationScript, type TurnIsolation } from "../../conversations/worktrees/isolation.js";
import { redirectCommand } from "../../conversations/worktrees/worktree-redirect.js";

// A watch check runs in the world its arming turn saw: that turn's namespace rebuilt, or its paths rewritten likewise.

// A check killed at this deadline, in ms, is a failed check, not a stuck watch.
const CHECK_TIMEOUT_MS = 60_000;
// Characters of output a check reports, from the end.
const OUTPUT_TAIL = 3_000;
// Characters captured per stream before capture stops.
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
    readonly failed?: string;
}

// Its own process group, so the deadline kills the check's whole tree, not just its shell.
const run = (argv: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<Spawned> =>
    new Promise((resolve) => {
        const [program, ...args] = argv;
        if (program === undefined) {
            resolve({ code: undefined, stdout: "", stderr: "", failed: "no command" });
            return;
        }
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn(program, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const kill = (): void => {
            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch {
                    // Already gone, which is the goal.
                }
            }
        };
        const deadline = setTimeout(kill, CHECK_TIMEOUT_MS);
        deadline.unref();
        const finish = (result: Spawned): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            resolve(result);
        };
        child.stdout.on("data", (chunk: Buffer) => {
            stdout = stdout.length < MAX_CAPTURE ? stdout + chunk.toString() : stdout;
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr = stderr.length < MAX_CAPTURE ? stderr + chunk.toString() : stderr;
        });
        child.on("error", (error: Error) => finish({ code: undefined, stdout, stderr, failed: error.message }));
        child.on("close", (code: number | null) => finish({ code: code ?? undefined, stdout, stderr }));
    });

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
