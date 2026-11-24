import { open, readdir, readFile, readlink } from "node:fs/promises";
import { type ExecResult, runProcess } from "../sync/exec.js";

/* THE SEAM between the fleet's decisions and the computer: every program it runs and every file it reads goes through
   one of these, so discovery, the keeper, the janitor and the slot holder are each tested against a fake computer
   (ci-fleet-testing.ts) rather than a real systemd. What a module writes and removes it does with node:fs on paths a test
   points at a temp folder, so those stay real. */

export interface FleetSys {
    readonly run: (command: string, args: readonly string[], options?: { readonly timeoutMs?: number; readonly cwd?: string }) => Promise<ExecResult>;
    // A file's text, or undefined when it is not there or not readable.
    readonly readText: (path: string) => Promise<string | undefined>;
    // The first `bytes` of a file (a runner's worker log runs to tens of megabytes), or undefined as readText.
    readonly readHead: (path: string, bytes: number) => Promise<string | undefined>;
    // A folder's entry names, or undefined when it is not there or not readable.
    readonly list: (path: string) => Promise<string[] | undefined>;
    // A symlink's target, or undefined when the path is not a link.
    readonly readLink: (path: string) => Promise<string | undefined>;
    readonly now: () => number;
}

const orUndefined = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try {
        return await work();
    } catch {
        // allow(silent-catch): a missing or unreadable file is an answer here, not a fault
        return undefined;
    }
};

export const machineSys: FleetSys = {
    run: async (command, args, options = {}) => await runProcess(command, args, { timeoutMs: options.timeoutMs ?? 60_000, cwd: options.cwd }),
    readText: async (path) => await orUndefined(() => readFile(path, "utf8")),
    readHead: async (path, bytes) =>
        await orUndefined(async () => {
            const handle = await open(path, "r");
            try {
                const buffer = Buffer.alloc(bytes);
                const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
                return buffer.subarray(0, bytesRead).toString("utf8");
            } finally {
                await handle.close();
            }
        }),
    list: async (path) => await orUndefined(() => readdir(path)),
    readLink: async (path) => await orUndefined(() => readlink(path)),
    now: () => Date.now(),
};

// A program's stdout, or a failure quoting what it said instead.
export const answered = (what: string, result: ExecResult): string => {
    if (result.status === 0) {
        return result.stdout;
    }
    const said = `${result.stderr}${result.stdout}`.trim().split(/\r?\n/u).slice(-5).join(" / ");
    throw new Error(`${what} failed (${result.status === null ? "it timed out or was killed" : `exit ${result.status}`})${said === "" ? "" : `: ${said}`}`);
};
