import { wslPathOf } from "@intentic/sandbox-contract";

// How a command crosses to the other environment of the same PC, as argv built here rather than a string quoted for
// the first shell: `wsl.exe --exec sh -lc <script>` into a distro, PowerShell through interop out of one.

// -NoProfile keeps profile customisations out of the output; -NonInteractive makes a prompt an error instead of a hang.
export const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

// Where a command runs: this environment, a WSL distro of this Windows PC, or the Windows side of this distro.
export type CommandTarget = { readonly kind: "native" } | { readonly kind: "wsl"; readonly distro: string | undefined } | { readonly kind: "windows" };

// `in` as the tool takes it: absent for here, "wsl" for the default distro, "wsl:<name>" for one by name, "windows".
export const targetOf = (raw: string | undefined): CommandTarget => {
    if (raw === undefined || raw === "") {
        return { kind: "native" };
    }
    if (raw === "windows") {
        return { kind: "windows" };
    }
    if (raw === "wsl") {
        return { kind: "wsl", distro: undefined };
    }
    if (raw.startsWith("wsl:") && raw.length > "wsl:".length) {
        return { kind: "wsl", distro: raw.slice("wsl:".length) };
    }
    throw new Error(`Unknown \`in\` "${raw}": use "wsl", "wsl:<distro>" or "windows".`);
};

export interface Interpreter {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string | undefined;
    readonly env: NodeJS.ProcessEnv;
}

// The Windows PowerShell a distro reaches through interop, PowerShell 7 preferred as on Windows itself.
export const WINDOWS_POWERSHELL = [
    "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
    "/mnt/c/Program Files/PowerShell/7-preview/pwsh.exe",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
];

// A command in one of this PC's distros. `--exec` hands sh its argv verbatim, so the script crosses as one argument
// and never meets PowerShell's quoting; `--cd ~` starts in the distro's home rather than this process's folder
// mapped under /mnt. A distro wsl.exe doesn't know is its own error, exit code and all.
const wslInterpreter = (distro: string | undefined, script: string, cwd: string | undefined, platform: NodeJS.Platform): Interpreter => {
    if (platform !== "win32") {
        throw new Error(`Only a Windows PC can run a command in WSL; this device runs ${platform}.`);
    }
    return {
        command: "wsl.exe",
        args: [...(distro === undefined ? [] : ["-d", distro]), "--cd", cwd ?? "~", "--exec", "sh", "-lc", script],
        cwd: undefined,
        env: { ...process.env, WSL_UTF8: "1" },
    };
};

// A command on the Windows side of this distro. Interop maps a /mnt working directory back to its drive; with none
// given the script starts in the Windows profile, since this process's own folder has no Windows name.
const windowsInterpreter = (script: string, cwd: string | undefined, inWsl: boolean, exists: (path: string) => boolean): Interpreter => {
    if (!inWsl) {
        throw new Error("Only a WSL distro can run a command on Windows; this device is not one.");
    }
    const command = WINDOWS_POWERSHELL.find(exists);
    if (command === undefined) {
        throw new Error("No PowerShell is reachable from this distro: Windows interop is off, or C: is not mounted at /mnt/c.");
    }
    const start = cwd === undefined ? undefined : cwd.startsWith("/mnt/") ? cwd : wslPathOf(cwd);
    if (cwd !== undefined && start === undefined) {
        throw new Error(`A Windows working directory is a drive path (C:\\Users\\you) or its /mnt form, not "${cwd}".`);
    }
    return {
        command,
        args: [...POWERSHELL_FLAGS, start === undefined ? `Set-Location -LiteralPath $env:USERPROFILE\n${script}` : script],
        cwd: start,
        env: process.env,
    };
};

// The argv for a command that crosses environments. A cross-over `cwd` names a folder in the other environment,
// which this door's roots (paths in this one) cannot bound; a command's reach was never bounded by its cwd, only
// its start.
export const crossInterpreter = (
    target: Exclude<CommandTarget, { kind: "native" }>,
    script: string,
    cwd: string | undefined,
    { platform, inWsl, exists }: { platform: NodeJS.Platform; inWsl: boolean; exists: (path: string) => boolean },
): Interpreter => (target.kind === "wsl" ? wslInterpreter(target.distro, script, cwd, platform) : windowsInterpreter(script, cwd, inWsl, exists));


// Names carried across the WSL boundary by WSLENV: `/u` from Windows into a distro, `/w` from a distro out to Windows.
export const crossEnv = (vars: Readonly<Record<string, string>>, direction: "u" | "w", base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
    const existing = (base["WSLENV"] ?? "").split(":").filter((entry) => entry !== "" && !Object.hasOwn(vars, entry.split("/")[0] ?? ""));
    return { ...base, ...vars, WSLENV: [...existing, ...Object.keys(vars).map((name) => `${name}/${direction}`)].join(":") };
};

// What the distro-side script answers when that distro has no agent installed; every other code is the agent's own.
export const NO_AGENT_EXIT = 64;

// The distro's installed agent is found by the distro's own $HOME, then run with argv: nothing is re-parsed by a shell.
const AGENT_IN_DISTRO_SH = `a="$HOME/.intentic/machine/bin/intentic-machine"; [ -x "$a" ] || exit ${NO_AGENT_EXIT}; exec "$a" "$@"`;

export const agentInDistro = (distro: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[] } => ({
    command: "wsl.exe",
    args: ["-d", distro, "--cd", "~", "--exec", "sh", "-c", AGENT_IN_DISTRO_SH, "sh", ...args],
});
