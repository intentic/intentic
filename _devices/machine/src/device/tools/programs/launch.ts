import { type ChildProcess, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { z } from "zod";

// HOW app_start STARTS A PROGRAM (programs.ts): as this agent's own detached child, or on Windows through
// intentic-launch, so that a console program has a console a stop can ask it through.

// A graceful stop's grace before it is forced, unless the run says otherwise (a target's `stopGraceSeconds`: a game
// server saving its world on a machine short of memory can need far more), and the most a run may ask for.
export const STOP_GRACE_SECONDS = 5;
const MAX_STOP_GRACE_SECONDS = 600;
const stopGraceInput = z
    .int()
    .min(1)
    .max(MAX_STOP_GRACE_SECONDS)
    .optional()
    .describe(
        `How long app_stop waits, once the program was asked to close, before forcing it. Default ${STOP_GRACE_SECONDS}; more for a program that saves on exit (a game server writing its world).`,
    );

const required = z.string().min(1);

// app_start's input (mcp.ts), here beside what reads it.
export const appStartInput = z.object({
    program: required.describe("A full path (a pushed build, or any program on this device), or a bare name found on its PATH."),
    args: z.array(z.string()).max(100).optional().describe("Arguments, each passed as is, with no shell between."),
    cwd: required.optional().describe("Working directory. Default: the program's own folder."),
    env: z.record(z.string(), z.string()).optional().describe("Environment variables to set on top of the agent's own."),
    name: required.optional().describe("What to call this run in app_status. Default: the program's name."),
    isolated: z
        .boolean()
        .optional()
        .describe(
            "Windows only: run it inside Windows Sandbox, a throwaway VM that sees the program's folder read-only and nothing else of this machine, and is discarded on app_stop. Needs Windows Pro/Enterprise with Windows Sandbox turned on; one at a time; boots in 10-20s.",
        ),
    network: z.boolean().optional().describe("With isolated: whether the VM has a network. Default true."),
    stopGraceSeconds: stopGraceInput,
});

// How long the launcher may take to say which pid the program it started has.
const LAUNCHER_PID_MS = 10_000;

export interface Spawned {
    readonly child: ChildProcess;
    readonly exit: Promise<{ code: number | null; signal: string | null }>;
    readonly programPid?: number | undefined;
}

const spawned = async (child: ChildProcess): Promise<Spawned> => {
    const exit = new Promise<{ code: number | null; signal: string | null }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
    await new Promise<void>((done, fail) => {
        child.once("spawn", () => done());
        child.once("error", (error) => fail(error));
    });
    return { child, exit };
};

// The program as this agent's own child, its output into the log. Its own process group (posix) or no console of ours
// (Windows, where `detached` also means no console at all: the fallback for a machine without intentic-launch): it
// outlives this agent, and a stop reaches everything it started. Not hidden, since an app is started to be seen.
export const startDirect = async (program: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, log: string): Promise<Spawned> => {
    const logHandle = await open(log, "a");
    try {
        return await spawned(
            spawn(program, [...args], { cwd, env, detached: true, windowsHide: false, stdio: ["ignore", logHandle.fd, logHandle.fd] }),
        );
    } finally {
        // The child holds its own copy of the descriptor.
        await logHandle.close();
    }
};

/* ON WINDOWS, THROUGH intentic-launch (2026-11-02). Node's `detached` on Windows is DETACHED_PROCESS: a console program
   started that way has no console at all, so nothing can ever ask it to stop (no window for WM_CLOSE, no console for a
   Ctrl-Break) and every stop of it was forced. `intentic-launch --wait` starts it with CREATE_NO_WINDOW, which gives a
   console program a console of its own with no window on the desktop, writes its output to the log, prints its pid, and
   lives as long as it does, ending with its exact exit code: this agent hears that exit as it would the program's. The
   program dies with the launcher (a job), so the run is one thing whichever is ended. A GUI program is started as it
   would be anyway. */
export const startThroughLauncher = async (
    launcher: string,
    program: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    log: string,
): Promise<Spawned> => {
    const child = spawn(launcher, ["--log", log, "--wait", "--", program, ...args], {
        cwd,
        env,
        detached: true,
        windowsHide: false,
        stdio: ["ignore", "pipe", "ignore"],
    });
    const started = await spawned(child);
    const said = await new Promise<string>((done) => {
        let text = "";
        const finish = (): void => {
            clearTimeout(timer);
            child.stdout?.removeAllListeners("data");
            child.stdout?.destroy();
            done(text);
        };
        const timer = setTimeout(finish, LAUNCHER_PID_MS);
        child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            text += chunk;
            if (text.includes("\n")) {
                finish();
            }
        });
        // A launcher that could not start the program ends without a pid, its reason written into the log.
        child.once("exit", finish);
    });
    const programPid = Number(said.trim().split(/\s+/)[0]);
    return { ...started, programPid: Number.isInteger(programPid) && programPid > 0 ? programPid : undefined };
};
