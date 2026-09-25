import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { homeDir } from "@intentic/local-agent";
import { sleep } from "@intentic/base/async";
import { COMMAND_CLASS_LABELS, type CommandClass, type DeviceScopes, matchCommand } from "@intentic/sandbox-contract";
import { assertPath, assertScope, rootsOf, ScopeError } from "../policy.js";
import { crossInterpreter, type Interpreter, POWERSHELL_FLAGS, targetOf } from "../../environments/crossing.js";
import { thisSide } from "../../wsl.js";

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
// How long the pipes may stay open once the command has exited. Whatever holds them after that was left running in
// the background, and does not get to hold the call open until it ends.
const PIPE_GRACE_MS = 1_000;
// How long a timed-out command's processes get to act on SIGTERM before SIGKILL.
const KILL_GRACE_MS = 2_000;

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

export interface CollectedOutput {
    readonly text: string;
    // Characters left out of the middle; the text marks where.
    readonly dropped: number;
}

export interface CommandResult {
    readonly exitCode: number | null;
    readonly stdout: CollectedOutput;
    readonly stderr: CollectedOutput;
    readonly timedOut: boolean;
    // Something the command started still held its output after it exited, and the call returned without waiting.
    readonly lingering: boolean;
}

// One stream in bounded memory: the head, a rolling tail, and a count of what fell between. Decoded as a stream, so a
// character split across two chunks arrives whole.
const collector = (): { readonly write: (chunk: Buffer) => void; readonly end: () => CollectedOutput } => {
    const decoder = new StringDecoder("utf8");
    const half = MAX_OUTPUT / 2;
    let head = "";
    let tail = "";
    let dropped = 0;
    const take = (text: string): void => {
        const room = Math.max(half - head.length, 0);
        head += text.slice(0, room);
        tail += text.slice(room);
        if (tail.length > half) {
            dropped += tail.length - half;
            tail = tail.slice(-half);
        }
    };
    return {
        write: (chunk) => take(decoder.write(chunk)),
        end: () => {
            take(decoder.end());
            return { text: dropped === 0 ? `${head}${tail}` : `${head}\n… [${dropped} characters cut] …\n${tail}`, dropped };
        },
    };
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
        process.kill(-pid, signal);
    } catch {
        // Nothing of the group is left to signal.
    }
};

// Everything the command started, not only its shell: SIGTERM to its process group, then SIGKILL to what is left.
// Windows has no process groups, and no SIGTERM a console program hears, so taskkill ends the whole tree at once.
const stopTree = async (child: ChildProcess): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
                .once("exit", () => resolve())
                .once("error", () => resolve());
        });
        // The shell at least, should taskkill have failed; a no-op once it has done its job.
        child.kill();
        return;
    }
    signalGroup(pid, "SIGTERM");
    await sleep(KILL_GRACE_MS);
    signalGroup(pid, "SIGKILL");
};

// Resolves once the command has exited and its output is in, not when the last process holding its pipes lets go:
// a server it started in the background would otherwise hold the call until the device call's own deadline.
const execute = async (interpreter: Interpreter, timeout: number): Promise<CommandResult> => {
    const child = spawn(interpreter.command, [...interpreter.args], {
        ...(interpreter.cwd === undefined ? {} : { cwd: interpreter.cwd }),
        env: interpreter.env,
        // No stdin: anything that asks a question reads EOF and fails fast instead of waiting out the timeout.
        stdio: ["ignore", "pipe", "pipe"],
        // A process group of its own, which a timeout ends whole. On Windows this would open a console window instead.
        detached: process.platform !== "win32",
        // No shell:true; the argv is already an interpreter invocation, and a second shell parsing it would mean
        // two layers of quoting rules.
        windowsHide: true,
    });
    const stdout = collector();
    const stderr = collector();
    child.stdout.on("data", stdout.write);
    child.stderr.on("data", stderr.write);
    // Listened for from the start: `close` can follow `exit` within the same tick.
    const closed = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
    let stopping: Promise<void> | undefined;
    const deadline = setTimeout(() => {
        stopping = stopTree(child);
    }, timeout);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", reject);
    }).finally(() => clearTimeout(deadline));
    await stopping;
    const drained = await Promise.race([closed, sleep(PIPE_GRACE_MS, { unref: true }).then(() => false)]);
    if (!drained) {
        child.stdout.destroy();
        child.stderr.destroy();
    }
    return { exitCode, stdout: stdout.end(), stderr: stderr.end(), timedOut: stopping !== undefined, lingering: !drained };
};

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
