import { describe, expect, it } from "vitest";
import { cliLauncher, quotedCommandLine } from "./launcher.js";

/* How a CLI re-invokes itself decides whether its background loop and its autostart entry ever run, and the two
 * install shapes need OPPOSITE argv. The released install is a `bun build --compile` binary whose
 * process.argv[1] is a path inside its own virtual filesystem; the runtime re-injects that entry on every
 * launch, so passing it again shifts the real command to argv[2] and every spawn dies with "No command
 * registered for `/$bunfs/root/…`". The sync agent shipped exactly that: mirroring silently never started on any
 * released build, and the broken argv was persisted into the autostart entry too. A plain `node dist/cli.js` run
 * still needs the script path. */
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

// Installed paths routinely contain spaces (C:\Users\First Last\…), and an unquoted Run value or Exec line
// splits on them into a command nobody registered.
describe("quotedCommandLine", () => {
    it("quotes every element", () => {
        expect(quotedCommandLine(["C:\\Program Files\\node.exe", "C:\\Users\\First Last\\cli.js", "mirror"])).toBe(
            '"C:\\Program Files\\node.exe" "C:\\Users\\First Last\\cli.js" "mirror"',
        );
    });
});
