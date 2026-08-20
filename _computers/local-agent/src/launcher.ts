/* HOW A LOCAL AGENT RE-INVOKES ITSELF, for the autostart entry it registers, and for the background loop it
 * spawns. Both need to write down a command line that will still start this CLI after a reboot.
 *
 * The subtlety is the compiled binary. These agents ship as one file built with `bun build --compile`, and such
 * a binary IS the CLI: its runtime re-injects a VIRTUAL `argv[1]` pointing inside the executable on every
 * launch. So the naive `[process.execPath, process.argv[1]]` is right for `node dist/cli.js` and wrong for the
 * released build, where it pushes the command name to `argv[2]`, where stricli never looks.
 *
 * That is not a theoretical failure. Every detached watcher the sync agent started died on the spot with
 * "No command registered for `/$bunfs/root/intentic-sync-linux-amd64`", and because the same argv was PERSISTED
 * into the autostart entry, port mirroring never ran on a released build at all, while `status` reported
 * "No forwarding sessions found" with nothing else to go on. The host agent inherited the fix by having its
 * author read that story; this module is the fix itself, so the next agent inherits the code. */

// The executable plus any leading argument that must precede the command. Non-empty by construction, only
// `cliLauncher` builds one.
export type CliLauncher = readonly [string, ...string[]];

const isBunVirtualEntry = (entry: string): boolean => entry.includes("$bunfs") || entry.includes("~BUN");

// `cliName` names the binary in the failure, which is the only thing a user can act on when argv[1] is missing.
export const cliLauncher = (cliName: string): CliLauncher => {
    const entry = process.argv[1];
    if (entry === undefined) {
        throw new Error(`cannot locate the ${cliName} entry to re-launch it`);
    }
    return isBunVirtualEntry(entry) ? [process.execPath] : [process.execPath, entry];
};

// An argv as ONE command line, for the mechanisms that take a string rather than an array (the XDG `Exec` key, a
// Windows Run value). Every element is quoted, installed paths routinely contain spaces (C:\Users\First Last\…,
// /Users/first last/…).
export const quotedCommandLine = (argv: readonly string[]): string => argv.map((arg) => `"${arg}"`).join(" ");
