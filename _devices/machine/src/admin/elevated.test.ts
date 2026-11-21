import type { ProcessResult } from "@intentic/base/process";
import { ELEVATED_TIMEOUT_MS, elevatedRun, runAsAdministrator, windowsArg } from "./elevated.js";

/* The one administrator's prompt this agent shows, as commands and as outcomes. Nothing is elevated here: the runner is
   handed what a prompt's PowerShell would have ended with. */

describe("an argument on a Windows command line", () => {
    test("stays as it is without a space or a quote, and is quoted with one, so a profile path with a space arrives whole", () => {
        expect(windowsArg("install")).toBe("install");
        expect(windowsArg("C:\\Users\\radar\\.intentic\\machine\\bin\\intentic-remoted.exe")).toBe("C:\\Users\\radar\\.intentic\\machine\\bin\\intentic-remoted.exe");
        expect(windowsArg("C:\\Users\\Jane Doe\\bin\\intentic-remoted.exe")).toBe('"C:\\Users\\Jane Doe\\bin\\intentic-remoted.exe"');
        expect(windowsArg("")).toBe('""');
    });

    test("escapes a quote, doubling the backslashes before it and those before the closing one", () => {
        expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
        expect(windowsArg('a\\"b')).toBe('"a\\\\\\"b"');
        expect(windowsArg("C:\\a dir\\")).toBe('"C:\\a dir\\\\"');
    });
});

describe("a program run as an administrator", () => {
    test("goes through Start-Process -Verb RunAs on Windows, each argument quoted as the program reads it back", () => {
        const { command, args } = elevatedRun("C:\\Program Files\\x.exe", ["service", "install", "--client", "C:\\Users\\Jane Doe\\r.exe"], "win32");
        expect(command).toBe("powershell.exe");
        expect(args.at(-1)).toBe(
            `$p = Start-Process -FilePath 'C:\\Program Files\\x.exe' -ArgumentList 'service','install','--client','"C:\\Users\\Jane Doe\\r.exe"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`,
        );
    });

    test("is pkexec with the arguments as they are on Linux", () => {
        expect(elevatedRun("/opt/x", ["service", "a b"], "linux")).toEqual({ command: "pkexec", args: ["/opt/x", "service", "a b"] });
    });
});

const ended = (overrides: Partial<ProcessResult>): ProcessResult => ({
    exitCode: 0,
    exitSignal: null,
    stdout: { text: "", dropped: 0 },
    stderr: { text: "", dropped: 0 },
    timedOut: false,
    aborted: false,
    lingering: false,
    ...overrides,
});

describe("how the prompt ended", () => {
    const elevated = { command: "powershell.exe", args: ["-Command", "x"] };

    test("waits ten minutes for the person, and reads exit 0 as done", async () => {
        const waited: number[] = [];
        const outcome = await runAsAdministrator(elevated, async (_command, _args, options) => {
            waited.push(options.timeoutMs);
            return ended({});
        });
        expect(outcome).toEqual({ kind: "done" });
        expect(waited).toEqual([ELEVATED_TIMEOUT_MS]);
        expect(ELEVATED_TIMEOUT_MS).toBe(600_000);
    });

    test("tells a prompt never shown, a no and a failure apart", async () => {
        expect(await runAsAdministrator(elevated, async () => ended({ exitCode: null, spawnError: new Error("ENOENT") }), "win32")).toEqual({
            kind: "unstarted",
            why: "powershell.exe could not be started: ENOENT",
        });
        const no = "Start-Process : This command cannot be run due to the error: The operation was canceled by the user.";
        const said = async () => ended({ exitCode: 1, stderr: { text: no, dropped: 0 } });
        expect(await runAsAdministrator(elevated, said, "win32")).toEqual({ kind: "declined" });
        // pkexec says a no by its exit code alone.
        expect(await runAsAdministrator(elevated, said, "linux")).toEqual({ kind: "failed", exitCode: 1, said: no, timedOut: false });
        expect(await runAsAdministrator(elevated, async () => ended({ exitCode: 126 }), "linux")).toEqual({ kind: "declined" });
        expect(await runAsAdministrator(elevated, async () => ended({ exitCode: null, timedOut: true }), "win32")).toEqual({
            kind: "failed",
            exitCode: null,
            said: "",
            timedOut: true,
        });
    });
});
