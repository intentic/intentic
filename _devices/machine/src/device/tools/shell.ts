import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { COMMAND_CLASS_LABELS, type CommandClass, type HostScopes, matchCommand, wslPathOf } from "@intentic/sandbox-contract";
import { assertPath, assertScope, rootsOf, ScopeError } from "../policy.js";
import { wslEnvironment } from "../../wsl.js";

// Running a command on somebody's device. The shell isn't negotiable per call: Windows gets PowerShell,
// everything else gets the login shell (so PATH, nvm/asdf/mise shims and aliases work), and `describe` reports
// which. `in` crosses to the other environment of the same PC, a WSL distro from Windows or Windows from a
// distro, as argv rather than a quoted string. Every command has a deadline, since nothing on the other end can
// answer a prompt. What the command would DO is checked too, not just whether shell is granted: the classifier
// below reads the same table the sandbox does (sandbox-contract/command-classes.ts), here beside the scopes.

// Long enough for an install or a test run, short of the hub's 15-minute ceiling; the agent can ask for more,
// up to the hard cap. Exported so the MCP tool's schema is built from these two numbers.
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// Output beyond this is truncated in the middle: the head says what the command did, the tail says how it
// ended, the megabyte of progress bars between them isn't worth a model's context.
const MAX_OUTPUT = 100_000;

// -NoProfile keeps profile customisations out of the output; -NonInteractive makes a prompt an error instead of a hang.
const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

export const shellFor = (
    platform: NodeJS.Platform,
): { readonly command: string; readonly args: (script: string) => string[]; readonly label: string } => {
    if (platform === "win32") {
        // PowerShell 7 when installed (what the skill pack is written for), else Windows PowerShell 5.1, which every
        // Windows has.
        const pwsh = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe"].find((path) =>
            existsSync(path),
        );
        const command = pwsh ?? "powershell.exe";
        return {
            command,
            args: (script) => [...POWERSHELL_FLAGS, script],
            label: pwsh === undefined ? "Windows PowerShell 5.1" : "PowerShell 7",
        };
    }
    const shell = process.env["SHELL"] ?? "/bin/sh";
    return { command: shell, args: (script) => ["-lc", script], label: shell };
};

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
const WINDOWS_POWERSHELL = [
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

// Read once per process: whether this agent runs inside a distro decides which way `in` can cross.
let insideWsl: Promise<boolean> | undefined;
const inWsl = (): Promise<boolean> => (insideWsl ??= wslEnvironment().then((environment) => environment !== undefined));

const truncate = (text: string): string =>
    text.length <= MAX_OUTPUT
        ? text
        : `${text.slice(0, MAX_OUTPUT / 2)}\n… [${text.length - MAX_OUTPUT} characters cut] …\n${text.slice(-MAX_OUTPUT / 2)}`;

export interface CommandResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
}

// The classes that need `destructive` on top of `shell`: each spends something this machine cannot get back
// (untracked files, a whole disk, a named container volume that on somebody's own computer IS the database).
// The rest of the catalog is deliberately not gated here.
const GATED_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>(["files.destructive", "system.destructive", "container.state"]);

// The refusal a destructive command earns, naming what the classifier saw so the user can judge the ask.
const destructiveRefusal = (classes: readonly CommandClass[]): string =>
    `Refused: this command would ${classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")} on this device, ` +
    `and "Run destructive commands" is switched off for it. Turn it on in its capability card to allow this, ` +
    `or run a command that does not delete.`;

// Which gated classes this command falls in, empty for ordinary work. Read at the `device` locus: `~`, `C:` and
// `/Users` are roots here, and `/usr` is the operating system rather than a layer of an image. Only where the
// fragment would run: `match.live` is false when it sits in a heredoc, a comment or an echo's quotes.
export const destructiveClasses = (command: string): CommandClass[] =>
    matchCommand(command, { locus: "device" })
        .filter((match) => match.live && GATED_CLASSES.has(match.commandClass))
        .map((match) => match.commandClass);

// This environment's own interpreter. The working directory is inside the roots like any other path: a command is a
// file operation with extra steps.
const nativeInterpreter = (script: string, cwd: string | undefined, scopes: HostScopes): Interpreter => {
    const shell = shellFor(process.platform);
    return {
        command: shell.command,
        args: shell.args(script),
        cwd: cwd === undefined ? (rootsOf(scopes)[0] ?? homedir()) : assertPath(cwd, scopes, "run a command in"),
        env: process.env,
    };
};

export const runCommand = async (
    input: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly in?: string },
    scopes: HostScopes,
): Promise<CommandResult> => {
    assertScope(scopes, "shell");
    // Read before the cwd is resolved, so a destructive command aimed outside the roots is refused for what it does
    // rather than for where it would have started.
    const destructive = destructiveClasses(input.command);
    if (destructive.length > 0 && scopes.destructive !== "on") {
        throw new ScopeError(destructiveRefusal(destructive));
    }
    const target = targetOf(input.in);
    const interpreter =
        target.kind === "native"
            ? nativeInterpreter(input.command, input.cwd, scopes)
            : crossInterpreter(target, input.command, input.cwd, { platform: process.platform, inWsl: await inWsl(), exists: existsSync });
    const timeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
        const child = spawn(interpreter.command, [...interpreter.args], {
            ...(interpreter.cwd === undefined ? {} : { cwd: interpreter.cwd }),
            env: interpreter.env,
            // No shell:true; the argv is already an interpreter invocation, and a second shell parsing it would mean
            // two layers of quoting rules.
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeout);
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        // stdin is closed immediately: anything that asks a question gets EOF and fails fast instead of waiting out
        // the timeout.
        child.stdin.end();
        child.on("error", (error) => {
            clearTimeout(timer);
            rejectPromise(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolvePromise({ exitCode: code, stdout: truncate(stdout), stderr: truncate(stderr), timedOut });
        });
    });
};

// The exit code is stated in words as well as in the number: on Windows a native program's failure does not
// stop the script, so the code is often the only evidence anything went wrong.
export const describeResult = (result: CommandResult, timeoutMs: number): string =>
    [
        result.timedOut
            ? `The command was killed after ${Math.round(timeoutMs / 1000)}s. It either takes longer than that, or it is waiting for input that nobody can type: there is no terminal on this end.`
            : `Exit code ${result.exitCode ?? "unknown"}${result.exitCode === 0 ? " (success)" : " (failed)"}.`,
        result.stdout.trim() === "" ? "" : `\n--- stdout ---\n${result.stdout.trimEnd()}`,
        result.stderr.trim() === "" ? "" : `\n--- stderr ---\n${result.stderr.trimEnd()}`,
    ]
        .filter((part) => part !== "")
        .join("");
