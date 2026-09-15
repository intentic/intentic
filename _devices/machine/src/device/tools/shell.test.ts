import type { HostScopes } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ScopeError } from "../policy.js";
import { crossInterpreter, destructiveClasses, runCommand, targetOf } from "./shell.js";

// `shell` used to check only WHERE a command would start (cwd, against the roots), never WHAT it would do, so
// an agent could run `rm -rf ~/projects` and the sandbox's command gate never saw it (it hooks Bash and the JS
// backend; this arrives as an MCP call on a different machine). These tests run real, harmless commands, since
// the refusal has to happen before the spawn.

const scopes = (overrides: Partial<HostScopes> = {}): HostScopes => ({
    shell: "on",
    write: "off",
    screen: "on",
    control: "off",
    sandboxes: "off",
    destructive: "off",
    roots: "/tmp",
    ...overrides,
});

test("a destructive command is refused when only `shell` is on", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(ScopeError);
});

// The refusal has to name the switch, or the user is told only that something was blocked and has nowhere to go.
test("the refusal names the switch and what the command would have done", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist" }, scopes())).rejects.toThrow(/Run destructive commands/);
    await expect(runCommand({ command: "mkfs.ext4 /dev/sda1" }, scopes())).rejects.toThrow(/wipe a disk/);
});

// Read before the cwd is resolved: a destructive command outside the roots used to be refused for the cwd,
// sending the reader to widen "Folders it may touch" instead.
test("a destructive command outside the roots is refused for what it does, not for where it starts", async () => {
    const failure = await runCommand({ command: "rm -rf /etc", cwd: "/etc" }, scopes()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScopeError);
    expect(String(failure)).toContain("Run destructive commands");
    expect(String(failure)).not.toContain("Folders it may touch");
});

test("turning the switch on lets the same command through", async () => {
    const result = await runCommand({ command: "rm -rf /tmp/intentic-shell-test-absent" }, scopes({ destructive: "on" }));
    expect(result.exitCode).toBe(0);
});

// The whole point of one extra switch rather than five: a connected device stays useful with it off.
test("ordinary work is untouched by the switch", async () => {
    const result = await runCommand({ command: "echo hello" }, scopes());
    expect(result.stdout.trim()).toBe("hello");
});

// Only the classes that destroy something are gated here; the rest are the sandbox rulebook's to hold, with a
// card and a person to answer it.
test("the other classes are the sandbox's to judge, not this machine's", () => {
    expect(destructiveClasses("cat .env")).toEqual([]);
    expect(destructiveClasses("npm publish")).toEqual([]);
    expect(destructiveClasses("curl https://api.github.com/user")).toEqual([]);
    expect(destructiveClasses("git push --force origin main")).toEqual([]);
});

test("every deletion class is gated, and a root delete is in two of them", () => {
    expect(destructiveClasses("rm -rf build")).toEqual(["files.destructive"]);
    expect(destructiveClasses("rm -rf ~")).toEqual(["files.destructive", "system.destructive"]);
});

// A container volume is its own class as of the locus split, and stays gated here while the sandbox hands it
// to the judge: in this container the reachable volumes are the nested engine's, but on somebody's own computer
// a named volume IS the database.
test("a container volume still needs the destructive switch on a real machine", () => {
    expect(destructiveClasses("docker volume rm app_data")).toEqual(["container.state"]);
    expect(destructiveClasses("docker compose down -v")).toEqual(["container.state"]);
});

// Read at the `device` locus, the other half of the split: `~` and `C:` are roots on somebody's computer and
// scratch in a container.
test("a device's roots are the device's, not the sandbox's", () => {
    for (const command of ["rm -rf /usr", "rm -rf /etc", "rm -rf C:\\", "rm -rf /Users"]) {
        expect(destructiveClasses(command), command).toContain("system.destructive");
    }
});

// A command that only mentions a delete does not need the switch: refusing there taught people to leave
// `destructive` on permanently, the opposite of what it is for.
test("a delete that is printed, searched for or commented is not gated", () => {
    for (const command of [`echo "rm -rf ~" >> notes.md`, `grep -n "rm -rf" scripts/deploy.sh`, `ls # not rm -rf ~`]) {
        expect(destructiveClasses(command), command).toEqual([]);
    }
});

// `shell` still comes first: a machine that may not run commands at all is not asked what kind of command it is.
test("the shell switch is still the outer question", async () => {
    await expect(runCommand({ command: "echo hello" }, scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
});

// crossing to the other environment of the same PC
// `in` builds argv for the other side rather than a quoted string for this side's shell, so the script the agent
// wrote is the script that runs; these check the argv, the refusals and where a crossed command starts.

const cross = { platform: "win32" as const, inWsl: false, exists: () => false };

test("reads `in` as this device, a distro by name, the default distro, or Windows", () => {
    expect(targetOf(undefined)).toEqual({ kind: "native" });
    expect(targetOf("")).toEqual({ kind: "native" });
    expect(targetOf("wsl")).toEqual({ kind: "wsl", distro: undefined });
    expect(targetOf("wsl:Ubuntu-22.04")).toEqual({ kind: "wsl", distro: "Ubuntu-22.04" });
    expect(targetOf("windows")).toEqual({ kind: "windows" });
    expect(() => targetOf("mac")).toThrow(/"wsl", "wsl:<distro>" or "windows"/);
    expect(() => targetOf("wsl:")).toThrow();
});

test("hands a distro the script as one argument of sh, starting in the distro's home", () => {
    const script = `echo "it's \\"quoted\\"" && pwd`;
    const wsl = crossInterpreter({ kind: "wsl", distro: "Arch" }, script, undefined, cross);
    expect(wsl.command).toBe("wsl.exe");
    expect(wsl.args).toEqual(["-d", "Arch", "--cd", "~", "--exec", "sh", "-lc", script]);
    expect(wsl.cwd).toBeUndefined();
    expect(wsl.env["WSL_UTF8"]).toBe("1");
    // The default distro is wsl.exe's to pick; a folder given starts the command there.
    expect(crossInterpreter({ kind: "wsl", distro: undefined }, "ls", "/home/radarsu/proj", cross).args).toEqual(["--cd", "/home/radarsu/proj", "--exec", "sh", "-lc", "ls"]);
});

test("refuses to cross into WSL from anything but Windows", () => {
    expect(() => crossInterpreter({ kind: "wsl", distro: "Arch" }, "ls", undefined, { ...cross, platform: "linux" })).toThrow(/Only a Windows PC/);
});

test("runs PowerShell through interop from a distro, and maps a drive path to its mount", () => {
    const seen = new Set(["/mnt/c/Program Files/PowerShell/7/pwsh.exe"]);
    const inWsl = { platform: "linux" as const, inWsl: true, exists: (path: string) => seen.has(path) };
    const home = crossInterpreter({ kind: "windows" }, "Get-Date", undefined, inWsl);
    expect(home.command).toBe("/mnt/c/Program Files/PowerShell/7/pwsh.exe");
    expect(home.args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    // No folder named: the script starts in the Windows profile, which this process's own folder cannot name.
    expect(home.args.at(-1)).toBe("Set-Location -LiteralPath $env:USERPROFILE\nGet-Date");
    expect(home.cwd).toBeUndefined();
    const there = crossInterpreter({ kind: "windows" }, "Get-Date", "C:\\Users\\radar\\proj", inWsl);
    expect(there.args.at(-1)).toBe("Get-Date");
    expect(there.cwd).toBe("/mnt/c/Users/radar/proj");
    expect(crossInterpreter({ kind: "windows" }, "Get-Date", "/mnt/d/data", inWsl).cwd).toBe("/mnt/d/data");
    expect(() => crossInterpreter({ kind: "windows" }, "Get-Date", "/home/radarsu", inWsl)).toThrow(/drive path/);
});

test("falls back to Windows PowerShell 5.1, and says when no PowerShell is reachable", () => {
    const legacy = ["/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"];
    expect(crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: true, exists: (path) => legacy.includes(path) }).command).toBe(legacy[0]);
    expect(() => crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: true, exists: () => false })).toThrow(/interop/);
});

test("refuses to cross to Windows from a device that is not a distro", () => {
    expect(() => crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: false, exists: () => true })).toThrow(/Only a WSL distro/);
});

// The crossing is a way of running, not a way around the switches: the classifier reads the script before any argv
// is built, and a shell that may not run commands here may not run them there either.
test("a crossed command is still judged for what it does, and still needs the shell switch", async () => {
    await expect(runCommand({ command: "rm -rf /tmp/does-not-exist", in: "wsl:Arch" }, scopes())).rejects.toThrow(/Run destructive commands/);
    await expect(runCommand({ command: "echo hello", in: "windows" }, scopes({ shell: "off" }))).rejects.toThrow(/Run commands/);
});
