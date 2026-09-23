import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

// What every process in the sandbox was started with and where it stands, read from procfs, so a clean can leave alone
// what a running program still names: the weights a model server loaded, a scratch folder a shell sits in. A process
// that exits mid-read is simply absent.

export interface RunningProgram {
    readonly argv: readonly string[];
    readonly cwd?: string;
}

export const readRunningPrograms = async (procRoot = "/proc"): Promise<RunningProgram[]> => {
    const pids = (await readdir(procRoot).catch(() => [] as string[])).filter((entry) => /^\d+$/.test(entry));
    const programs = await Promise.all(
        pids.map(async (pid): Promise<RunningProgram[]> => {
            const [cmdline, cwd] = await Promise.all([
                readFile(join(procRoot, pid, "cmdline"), "utf8").catch(() => ""),
                readlink(join(procRoot, pid, "cwd")).catch(() => undefined),
            ]);
            const argv = cmdline.split("\0").filter((arg) => arg !== "");
            return argv.length === 0 && cwd === undefined ? [] : [{ argv, ...(cwd === undefined ? {} : { cwd }) }];
        }),
    );
    return programs.flat();
};

// Whether a running program names the path on its command line, or stands inside it.
export const namedByProgram = (programs: readonly RunningProgram[], path: string): boolean =>
    programs.some(
        (program) =>
            (program.cwd !== undefined && (program.cwd === path || program.cwd.startsWith(`${path}/`))) || program.argv.some((arg) => arg.includes(path)),
    );

// pnpm itself, however it was launched: its own binary, or node running its script.
const PNPM = /(^|\/)(pnpm|pnpx)(\.c?js)?$/;

// An install in flight links from the store as it goes; pruning under it would pull files out from beneath it.
export const pnpmRunning = (programs: readonly RunningProgram[]): boolean => programs.some((program) => program.argv.slice(0, 2).some((arg) => PNPM.test(arg)));
