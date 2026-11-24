import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { ScopeError } from "../../policy.js";
import { ADMIN_NOT_CROSSING, ADMIN_NOT_WINDOWS, type AdminRunSeams, adminRunArgs, adminRunFailure, adminRunVerdict, realAdminRunSeams } from "./admin-run.js";
import { runCommand } from "../shell.js";
import { grantWith } from "../../device-testing.js";

// run_command's `admin` (2026-11-23): refused before anything starts where it cannot work, and otherwise the command
// handed to `intentic-remoted service admin-run`, whose status file says whether it ran. A shell script stands in for
// remoted here, so the whole path runs on Linux: what reaches remoted, how its status reads, and the answer the agent
// gets.

const scopes = (overrides: Partial<DeviceScopes> = {}): DeviceScopes => grantWith(["shell", "screen", "admin"], { roots: tmpdir(), ...overrides });

const NEVER: AdminRunSeams = {
    binary: () => Promise.reject(new Error("no remoted should be asked for")),
    statusFile: () => "/nonexistent",
    readStatus: () => Promise.resolve(undefined),
};
const windows = (seams: AdminRunSeams = NEVER) => ({ platform: "win32" as const, seams: () => seams });

test("remoted is asked with the status file, the folder, and the program after --", () => {
    expect(adminRunArgs("C:\\t\\s.json", "C:\\Users\\a b", "pwsh.exe", ["-NoProfile", "-Command", "Get-Date"])).toEqual([
        "service",
        "admin-run",
        "--status",
        "C:\\t\\s.json",
        "--cwd",
        "C:\\Users\\a b",
        "--",
        "pwsh.exe",
        "-NoProfile",
        "-Command",
        "Get-Date",
    ]);
});

test("the sandbox's grant goes to remoted before the program, and an ungranted run asks without one", () => {
    expect(adminRunArgs("S", "C:\\", "pwsh.exe", ["-Command", "x"], '{"payload":"p","sig":"s"}')).toEqual([
        "service",
        "admin-run",
        "--status",
        "S",
        "--cwd",
        "C:\\",
        "--grant",
        '{"payload":"p","sig":"s"}',
        "--",
        "pwsh.exe",
        "-Command",
        "x",
    ]);
    expect(adminRunArgs("S", "C:\\", "pwsh.exe", [])).not.toContain("--grant");
    expect(adminRunFailure({ ran: false, reason: "untrusted", error: "" })).toContain("does not know this sandbox's key");
    expect(adminRunFailure({ ran: false, reason: "refused", error: "the grant has expired" })).toContain("the grant has expired");
});

test("off Windows, across into a distro, or with the switch off, nothing is asked of remoted", async () => {
    await expect(runCommand({ command: "whoami", admin: true }, scopes(), { platform: "linux", seams: () => NEVER })).rejects.toThrow(ADMIN_NOT_WINDOWS);
    await expect(runCommand({ command: "whoami", admin: true, in: "wsl" }, scopes(), windows())).rejects.toThrow(ADMIN_NOT_CROSSING);
    const off = await runCommand({ command: "whoami", admin: true }, scopes({ admin: "off" }), windows()).catch((error: unknown) => error);
    expect(off).toBeInstanceOf(ScopeError);
    expect(String(off)).toContain("Run commands as administrator");
});

test("the switches every command answers to still come first", async () => {
    await expect(runCommand({ command: "whoami", admin: true }, scopes({ shell: "off" }), windows())).rejects.toThrow(/Run commands/);
    await expect(runCommand({ command: "rm -rf C:\\Users", admin: true }, scopes(), windows())).rejects.toThrow(/Run destructive commands/);
});

test("each reason remoted gives reads as what to do about it", () => {
    const words = (reason: string) => adminRunFailure({ ran: false, reason, error: "the pipe is gone" });
    expect(words("not-installed")).toContain("Remote access");
    expect(words("not-installed")).toContain("Start-Process -Verb RunAs");
    expect(words("outdated")).toContain("set up again");
    expect(words("nobody-signed-in")).toContain("nobody is signed in");
    expect(words("not-administrator")).toContain("not an administrator");
    expect(words("start-failed")).toBe("Not run as administrator: the pipe is gone");
});

test("a run that ran, or was stopped at its deadline, stands as an ordinary run's answer", () => {
    expect(adminRunVerdict({ ran: true, exitCode: 4 }, { timedOut: false, exitCode: 4, stderr: "" })).toBeUndefined();
    expect(adminRunVerdict(undefined, { timedOut: true, exitCode: null, stderr: "" })).toBeUndefined();
    expect(adminRunVerdict(undefined, { timedOut: false, exitCode: 2, stderr: "usage: …\nunknown argument" })).toContain("exit 2");
});

describe("through a stand-in remoted", () => {
    let dir = "";
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), "admin-run-"));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    // Writes what it was asked to `seen`, then `status` to the status file, prints, and exits with `code`.
    const standIn = async (status: string, code: number): Promise<AdminRunSeams> => {
        const script = join(dir, `remoted-${String(code)}.sh`);
        await writeFile(
            script,
            `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/seen"\nwhile [ "$1" != "--status" ]; do shift; done\nprintf '%s\\n' '${status}' > "$2"\necho elevated out\necho elevated err >&2\nexit ${String(code)}\n`,
        );
        await chmod(script, 0o755);
        return { ...realAdminRunSeams(() => undefined), binary: () => Promise.resolve(script), statusFile: () => join(dir, `status-${String(code)}.json`) };
    };

    test("the command's output and exit code come back, and the status file is cleared", async () => {
        const seams = await standIn('{"ran":true,"exitCode":7}', 7);
        const result = await runCommand({ command: "Get-Service", admin: true, cwd: tmpdir(), grant: "GRANT" }, scopes(), windows(seams));
        expect(result.exitCode).toBe(7);
        expect(result.stdout.text).toContain("elevated out");
        expect(result.stderr.text).toContain("elevated err");
        const seen = (await readFile(join(dir, "seen"), "utf8")).split("\n");
        expect(seen.slice(0, 2)).toEqual(["service", "admin-run"]);
        expect(seen).toContain("Get-Service");
        expect(seen[seen.indexOf("--grant") + 1]).toBe("GRANT");
        await expect(readFile(join(dir, "status-7.json"), "utf8")).rejects.toThrow();
    });

    test("a command that did not run fails the call with remoted's reason in words", async () => {
        const seams = await standIn('{"ran":false,"reason":"not-installed","error":"no service"}', 125);
        await expect(runCommand({ command: "Get-Service", admin: true, cwd: tmpdir() }, scopes(), windows(seams))).rejects.toThrow(/Remote access/);
    });
});
