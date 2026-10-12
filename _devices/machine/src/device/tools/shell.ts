import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homeDir } from "@intentic/local-agent";
import { COMMAND_CLASS_LABELS, type CommandClass, type DeviceScopes, matchCommand, hardRuleClasses } from "@intentic/sandbox-contract";
import { type CollectedOutput, runBounded, stopProcessTree } from "@intentic/base/process";
import { assertPath, assertScope, rootsOf, ScopeError } from "../policy.js";
import { crossInterpreter, type Interpreter, POWERSHELL_FLAGS, targetOf } from "../../environments/crossing.js";
import { thisSide } from "../../environments/wsl.js";
import { forgetCommand, recordCommand } from "./command-ledger.js";

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
// Characters kept per stream, half from the start and half from the end: the head says what the command did, the
// tail says how it ended, and the megabyte of progress bars between them is counted rather than kept.
const MAX_OUTPUT = 100_000;

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

export type { CollectedOutput };

export interface CommandResult {
    readonly exitCode: number | null;
    readonly stdout: CollectedOutput;
    readonly stderr: CollectedOutput;
    readonly timedOut: boolean;
    // Something the command started still held its output after it exited, and the call returned without waiting.
    readonly lingering: boolean;
}

// Every command running right now. The agent's supervisor no longer takes them down with it (KillMode=process, so an
// ic mid-swap outlives a restart), so a stopping agent ends them itself: nobody is left to read their answer, and their
// deadline dies with it. One the agent dies under is ended by the next agent instead (command-ledger.ts).
const inFlight = new Set<ChildProcess>();

export const stopRunningCommands = async (): Promise<void> => {
    await Promise.all([...inFlight].map(async (child) => await stopProcessTree(child)));
};

// The command's process as it spawns, and its entry in the ledger: a holder rather than two `let`s, which the compiler
// would read as still unset once the run is over.
interface Spawned {
    child?: ChildProcess;
    recorded?: Promise<void>;
}

// Resolves once the command has exited and its output is in, not when the last process holding its pipes lets go:
// a server it started in the background would otherwise hold the call until the device call's own deadline. The
// runner gives it a process group of its own, which the deadline ends whole, and no stdin, so anything that asks a
// question reads EOF and fails fast instead of waiting out the timeout. No shell:true: the argv is already an
// interpreter invocation, and a second shell parsing it would mean two layers of quoting rules.
const execute = async (interpreter: Interpreter, timeout: number): Promise<CommandResult> => {
    const spawned: Spawned = {};
    const result = await runBounded(interpreter.command, interpreter.args, {
        cwd: interpreter.cwd,
        env: interpreter.env,
        timeoutMs: timeout,
        maxOutput: MAX_OUTPUT,
        onSpawn: (child) => {
            spawned.child = child;
            inFlight.add(child);
            // Written down before it can be crossed off: a command that ends at once must not leave its entry behind.
            if (child.pid !== undefined && process.platform !== "win32") {
                spawned.recorded = recordCommand(child.pid);
            }
        },
    });
    const { child, recorded = Promise.resolve() } = spawned;
    if (child !== undefined) {
        inFlight.delete(child);
        const pid = child.pid;
        if (pid !== undefined) {
            void recorded.then(async () => await forgetCommand(pid));
        }
    }
    // A command that could not start at all (a missing interpreter) is the call's failure, as it always was.
    if (result.spawnError !== undefined) {
        throw result.spawnError;
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, lingering: result.lingering };
};

// The classes that need `destructive` on top of `shell`: each spends something this machine cannot get back
// (untracked files, a whole disk, a named container volume that on somebody's own computer IS the database). The
// contract's hard rule for a device is that set, so the Safety page's panel and this gate cannot disagree. The rest of
// the catalog is deliberately not gated here.
const GATED_CLASSES: ReadonlySet<CommandClass> = hardRuleClasses("device");

// The refusal a destructive command earns, naming what the classifier saw so the user can judge the ask.
export const destructiveRefusal = (classes: readonly CommandClass[]): string =>
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
const nativeInterpreter = async (script: string, cwd: string | undefined, scopes: DeviceScopes): Promise<Interpreter> => {
    const shell = shellFor(process.platform);
    return {
        command: shell.command,
        args: shell.args(script),
        cwd: cwd === undefined ? (rootsOf(scopes)[0] ?? homeDir()) : await assertPath(cwd, scopes, "run a command in"),
        env: process.env,
    };
};

export const runCommand = async (
    input: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly in?: string },
    scopes: DeviceScopes,
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
            ? await nativeInterpreter(input.command, input.cwd, scopes)
            : crossInterpreter(target, input.command, input.cwd, await thisSide(), existsSync);
    return await execute(interpreter, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
};

const cutFrom = (result: CommandResult): string => {
    const cuts = [
        { name: "stdout", dropped: result.stdout.dropped },
        { name: "stderr", dropped: result.stderr.dropped },
    ].filter((stream) => stream.dropped > 0);
    return cuts.length === 0 ? "" : ` Too long to return whole: ${cuts.map((stream) => `${stream.dropped} characters from the middle of ${stream.name}`).join(" and ")} are left out, where it says so.`;
};

// The exit code is stated in words as well as in the number: on Windows a native program's failure does not
// stop the script, so the code is often the only evidence anything went wrong.
export const describeResult = (result: CommandResult, timeoutMs: number): string =>
    [
        result.timedOut
            ? `The command was stopped after ${Math.round(timeoutMs / 1000)}s, and everything it started with it. It either takes longer than that, or it is waiting for input that nobody can type: there is no terminal on this end.`
            : `Exit code ${result.exitCode ?? "unknown"}${result.exitCode === 0 ? " (success)" : " (failed)"}.`,
        cutFrom(result),
        result.lingering
            ? " It left something running in the background, and what that prints from now on is not collected: start background work with its output redirected to a file (`> out.log 2>&1`), or it may fail on its next write to a pipe nobody reads."
            : "",
        result.stdout.text.trim() === "" ? "" : `\n--- stdout ---\n${result.stdout.text.trimEnd()}`,
        result.stderr.text.trim() === "" ? "" : `\n--- stderr ---\n${result.stderr.text.trimEnd()}`,
    ]
        .filter((part) => part !== "")
        .join("");
