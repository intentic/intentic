import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Builds the argv to re-invoke this CLI, for autostart and the background loop. A bun-compiled binary re-injects a
// virtual argv[1] on every launch, so passing it again shifts the real command to argv[2] where stricli never looks;
// only `node dist/cli.js` needs the script path repeated.

// The executable plus any leading argument that must precede the command; only cliLauncher builds one.
export type CliLauncher = readonly [string, ...string[]];

const isBunVirtualEntry = (entry: string): boolean => entry.includes("$bunfs") || entry.includes("~BUN");

// Names the binary in the failure: the one thing a user can act on when argv[1] is missing.
export const cliLauncher = (cliName: string): CliLauncher => {
    const entry = process.argv[1];
    if (entry === undefined) {
        throw new Error(`cannot locate the ${cliName} entry to re-launch it`);
    }
    return isBunVirtualEntry(entry) ? [process.execPath] : [process.execPath, entry];
};

// One command line for mechanisms that take a string, not an array (XDG Exec, a Windows Run value); every element is
// quoted since installed paths often contain spaces.
export const quotedCommandLine = (argv: readonly string[]): string => argv.map((arg) => `"${arg}"`).join(" ");

// GUI-subsystem exe with CREATE_NO_WINDOW; found beside the executable only, never via PATH.
export const WINDOWS_LAUNCH_STUB = "intentic-launch.exe";

export const windowsLaunchStub = (launcher: CliLauncher): string | undefined => {
    if (process.platform !== "win32") {
        return undefined;
    }
    const candidate = join(dirname(launcher[0]), WINDOWS_LAUNCH_STUB);
    return existsSync(candidate) ? candidate : undefined;
};

// One spelling of the stub command line, used both in the registry value and the spawn, so the two can't drift. Log
// path first; everything after `--` belongs to the child verbatim.
export const stubCommand = (stub: string, logPath: string, argv: readonly string[]): readonly [string, ...string[]] => [
    stub,
    "--log",
    logPath,
    "--",
    ...argv,
];
