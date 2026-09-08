import { describe, expect, it } from "vitest";
import { cliLauncher, quotedCommandLine, stubCommand } from "./launcher.js";

// A bun-compiled binary re-injects its own entry (argv[1]) on every launch, so passing it again shifts the real
// command; a plain node invocation still needs the script path.
describe("cliLauncher", () => {
    const withEntry = <T>(entry: string | undefined, run: () => T): T => {
        const argv = process.argv;
        process.argv = entry === undefined ? [process.execPath] : [process.execPath, entry];
        try {
            return run();
        } finally {
            process.argv = argv;
        }
    };

    it("passes the script path for a plain node invocation", () => {
        expect(withEntry("/opt/intentic/sync/dist/cli.js", () => cliLauncher("intentic-sync"))).toEqual([
            process.execPath,
            "/opt/intentic/sync/dist/cli.js",
        ]);
    });

    it("omits the virtual entry for a bun-compiled binary", () => {
        expect(withEntry("/$bunfs/root/intentic-sync-linux-amd64", () => cliLauncher("intentic-sync"))).toEqual([process.execPath]);
    });

    it("omits the virtual entry on Windows, where bun roots it elsewhere", () => {
        expect(withEntry("B:\\~BUN\\root\\intentic-host-windows-amd64.exe", () => cliLauncher("intentic-host"))).toEqual([process.execPath]);
    });

    it("refuses to guess when there is no entry at all, naming the binary the user can act on", () => {
        expect(() => withEntry(undefined, () => cliLauncher("intentic-host"))).toThrow(/cannot locate the intentic-host entry/);
    });
});

// Installed paths often contain spaces; an unquoted Run value or Exec line splits on them into an unregistered command.
describe("quotedCommandLine", () => {
    it("quotes every element", () => {
        expect(quotedCommandLine(["C:\\Program Files\\node.exe", "C:\\Users\\First Last\\cli.js", "mirror"])).toBe(
            '"C:\\Program Files\\node.exe" "C:\\Users\\First Last\\cli.js" "mirror"',
        );
    });
});

// Registry value and spawn args both come from one function so the two shapes can't drift; the parser is rigid about
// order (`--log <file> -- <program> ...`).
describe("stubCommand", () => {
    it("puts the log first and everything the child owns after the separator", () => {
        expect(stubCommand("C:\\bin\\intentic-launch.exe", "C:\\logs\\host.log", ["C:\\bin\\intentic-host.exe", "run", "--foreground"])).toEqual([
            "C:\\bin\\intentic-launch.exe",
            "--log",
            "C:\\logs\\host.log",
            "--",
            "C:\\bin\\intentic-host.exe",
            "run",
            "--foreground",
        ]);
    });
});
