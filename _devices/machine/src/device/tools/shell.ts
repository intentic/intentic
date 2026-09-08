import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { COMMAND_CLASS_LABELS, type CommandClass, type HostScopes, matchCommand } from "@intentic/sandbox-contract";
import { assertPath, assertScope, rootsOf, ScopeError } from "../policy.js";

// Running a command on somebody's device. The shell isn't negotiable per call: Windows gets PowerShell,
// everything else gets the login shell (so PATH, nvm/asdf/mise shims and aliases work), and `describe` reports
// which. Every command has a deadline, since nothing on the other end can answer a prompt. What the command
// would DO is checked too, not just whether shell is granted: the classifier below reads the same table the
// sandbox does (sandbox-contract/command-classes.ts), here beside the scopes.

// Long enough for an install or a test run, short of the hub's 15-minute ceiling; the agent can ask for more,
// up to the hard cap. Exported so the MCP tool's schema is built from these two numbers.
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// Output beyond this is truncated in the middle: the head says what the command did, the tail says how it
// ended, the megabyte of progress bars between them isn't worth a model's context.
const MAX_OUTPUT = 100_000;

export const shellFor = (
    platform: NodeJS.Platform,
): { readonly command: string; readonly args: (script: string) => string[]; readonly label: string } => {
    if (platform === "win32") {
        // PowerShell 7 when installed (what the skill pack is written for), else Windows PowerShell 5.1, which every
        // Windows has. -NoProfile keeps profile customisations out of the output; -NonInteractive makes a prompt an
        // error instead of a hang.
        const pwsh = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe"].find((path) =>
            existsSync(path),
        );
        const command = pwsh ?? "powershell.exe";
        return {
            command,
            args: (script) => ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            label: pwsh === undefined ? "Windows PowerShell 5.1" : "PowerShell 7",
        };
    }
    const shell = process.env["SHELL"] ?? "/bin/sh";
    return { command: shell, args: (script) => ["-lc", script], label: shell };
};

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

export const runCommand = async (
    input: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number },
    scopes: HostScopes,
): Promise<CommandResult> => {
    assertScope(scopes, "shell");
    // Read before the cwd is resolved, so a destructive command aimed outside the roots is refused for what it does
    // rather than for where it would have started.
    const destructive = destructiveClasses(input.command);
    if (destructive.length > 0 && scopes.destructive !== "on") {
        throw new ScopeError(destructiveRefusal(destructive));
    }
    // The working directory is inside the roots like any other path: a command is a file operation with extra steps.
    const cwd = input.cwd === undefined ? (rootsOf(scopes)[0] ?? homedir()) : assertPath(input.cwd, scopes, "run a command in");
    const timeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = shellFor(process.platform);

    return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
        const child = spawn(shell.command, shell.args(input.command), {
            cwd,
            env: process.env,
            // No shell:true; the argv is already an interpreter invocation, and a second shell parsing it would mean
            // two
            // layers of quoting rules.
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
