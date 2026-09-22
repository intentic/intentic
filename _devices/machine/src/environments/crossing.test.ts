import { test, expect } from "bun:test";
import { agentInDistro, crossEnv, crossInterpreter, NO_AGENT_EXIT, targetOf } from "./crossing.js";

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
    expect(crossInterpreter({ kind: "wsl", distro: undefined }, "ls", "/home/radarsu/proj", cross).args).toEqual([
        "--cd",
        "/home/radarsu/proj",
        "--exec",
        "sh",
        "-lc",
        "ls",
    ]);
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
    const legacy = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    expect(
        crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: true, exists: (path) => path === legacy }).command,
    ).toBe(legacy);
    expect(() => crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: true, exists: () => false })).toThrow(
        /interop/,
    );
});

test("refuses to cross to Windows from a device that is not a distro", () => {
    expect(() => crossInterpreter({ kind: "windows" }, "Get-Date", undefined, { platform: "linux", inWsl: false, exists: () => true })).toThrow(
        /Only a WSL distro/,
    );
});


// The two env vars the machine's own environments pass each other must arrive, and the caller's own WSLENV with them.
test("passes named variables across WSL in the direction asked, keeping what WSLENV already carried", () => {
    const env = crossEnv({ INTENTIC_MACHINE_UPGRADE: "1.305.0" }, "u", { WSLENV: "USERPROFILE/p", PATH: "C:\\bin" });
    expect(env["INTENTIC_MACHINE_UPGRADE"]).toBe("1.305.0");
    expect(env["WSLENV"]).toBe("USERPROFILE/p:INTENTIC_MACHINE_UPGRADE/u");
    expect(env["PATH"]).toBe("C:\\bin");
    // A name already listed is replaced rather than repeated with a second direction.
    expect(crossEnv({ A: "1" }, "w", { WSLENV: "A/u" })["WSLENV"]).toBe("A/w");
});

// The version, a distro name and a flag reach the distro's agent as argv; a second shell never re-parses them.
test("runs the distro's own agent with argv, from the distro's own home", () => {
    const { command, args } = agentInDistro("archlinux", ["upgrade", "--here"]);
    expect(command).toBe("wsl.exe");
    expect(args.slice(0, 7)).toEqual(["-d", "archlinux", "--cd", "~", "--exec", "sh", "-c"]);
    expect(args[7]).toContain(`"$HOME/.intentic/machine/bin/intentic-machine"`);
    expect(args[7]).toContain(`exit ${NO_AGENT_EXIT}`);
    expect(args.slice(8)).toEqual(["sh", "upgrade", "--here"]);
});
