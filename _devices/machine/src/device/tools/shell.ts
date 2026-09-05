import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { classifyCommand, COMMAND_CLASS_LABELS, type CommandClass, type HostScopes } from "@intentic/sandbox-contract";
import { assertPath, assertScope, rootsOf, ScopeError } from "../policy.js";

/* Running a command on somebody's device, the tool that does most of the work, and the one whose failure
 * modes are worth designing around rather than discovering.
 *
 * THE SHELL IS NOT NEGOTIABLE PER CALL. The agent does not get to pick an interpreter (that is an escape from
 * the platform's quoting rules, and from the skill pack that taught it those rules): Windows gets PowerShell,
 * everything else gets the login shell. `describe` reports which, so the agent writes for the right one from
 * its first call.
 *
 * A LOGIN SHELL, deliberately, on Linux: the user's PATH, their nvm/asdf/mise shims and their aliases are most
 * of what makes a command work on a developer's machine, and a non-login `sh -c` finds none of it, producing
 * "node: command not found" on a box with four node versions installed.
 *
 * EVERY COMMAND HAS A DEADLINE. There is no terminal on the other end: a command that waits for input (an
 * unprimed `sudo`, an `npm login`, anything with a "[y/N]") would hang until the socket died. The timeout turns
 * that into a message the agent can act on, and the message says what it means rather than "timed out".
 *
 * WHAT THE COMMAND SAYS IS PART OF THE GRANT, not just whether there is a grant. `shell` used to be the whole
 * question and `cwd` the only thing read: a command was checked for WHERE it started and never for WHAT it did,
 * so an agent that had been told it could run commands could run `rm -rf ~/projects` with the user's own
 * privileges, and the sandbox's command gate never saw it, because that gate hooks Bash and the JS backend and
 * this arrives as an MCP tool call. The classifier below closes that: same table the sandbox reads
 * (sandbox-contract/command-classes.ts), consulted HERE, on the machine, beside the scopes, because that is
 * where this product's whole argument says enforcement lives.
 *
 * ONE EXTRA SWITCH, NOT FIVE. Only the two classes that destroy something are gated (`destructive` on the
 * card). Reading a dotenv, publishing a package and reaching the network are the sandbox's rulebook to hold,
 * with a card and a person to answer it; re-asking them here, where a refusal is the only available answer,
 * would turn a connected laptop into a machine that says no a lot. */

/* Long enough for an install or a test run, short enough that a wedged command doesn't hold a tool call for the
 * hub's whole 15-minute ceiling. The agent can ask for more, up to the hard cap.
 *
 * Exported because the MCP tool's schema is built from them: the default the model is offered and the ceiling it
 * is held to are these two numbers, so a deadline past the cap is refused up front rather than accepted, silently
 * lowered here, and then reported back as the number that was asked for. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
// Output beyond this is truncated in the middle: the head says what the command did, the tail says how it
// ended, and the megabyte of npm progress bars in between is not worth a model's context.
const MAX_OUTPUT = 100_000;

export const shellFor = (
    platform: NodeJS.Platform,
): { readonly command: string; readonly args: (script: string) => string[]; readonly label: string } => {
    if (platform === "win32") {
        // PowerShell 7 when it is installed (a strictly better shell, and what the skill pack is written for),
        // else Windows PowerShell 5.1, which every Windows has. -NoProfile keeps a user's prompt customisations
        // and module autoloads out of the output; -NonInteractive makes a prompt an error instead of a hang.
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

/* The classes that need `destructive` on top of `shell`. Both spend something this machine cannot get back:
 * files that no worktree or checkpoint holds a copy of, and disks or volumes that hold everything else. The
 * rest of the catalog is deliberately absent, see the header. */
const GATED_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>(["files.destructive", "system.destructive"]);

// The refusal a destructive command earns, naming what the classifier saw so the user can judge the ask rather
// than being told only that something was blocked.
const destructiveRefusal = (classes: readonly CommandClass[]): string =>
    `Refused: this command would ${classes.map((commandClass) => COMMAND_CLASS_LABELS[commandClass]).join(" and ")} on this device, ` +
    `and "Run destructive commands" is switched off for it. Turn it on in its capability card to allow this, ` +
    `or run a command that does not delete.`;

// Which gated classes this command falls in, empty when it is ordinary work.
export const destructiveClasses = (command: string): CommandClass[] =>
    classifyCommand(command).filter((commandClass) => GATED_CLASSES.has(commandClass));

export const runCommand = async (
    input: { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number },
    scopes: HostScopes,
): Promise<CommandResult> => {
    assertScope(scopes, "shell");
    /* Read BEFORE the cwd is resolved, so a destructive command aimed outside the roots is refused for what it
     * does rather than for where it would have started: the second message sends somebody to widen "Folders it
     * may touch", which is the opposite of the change they want to make. */
    const destructive = destructiveClasses(input.command);
    if (destructive.length > 0 && scopes.destructive !== "on") {
        throw new ScopeError(destructiveRefusal(destructive));
    }
    // The working directory is inside the roots like any other path, a command is a file operation with extra
    // steps, and starting it in a directory the user walled off is the same breach as reading from there.
    const cwd = input.cwd === undefined ? (rootsOf(scopes)[0] ?? homedir()) : assertPath(input.cwd, scopes, "run a command in");
    const timeout = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = shellFor(process.platform);

    return await new Promise<CommandResult>((resolvePromise, rejectPromise) => {
        const child = spawn(shell.command, shell.args(input.command), {
            cwd,
            env: process.env,
            // No shell:true, the argv is already an interpreter invocation, and letting a second shell parse it
            // would mean two layers of quoting rules for the agent to get right.
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
        // stdin is closed immediately: anything that asks a question gets EOF and fails fast, instead of waiting
        // out the timeout for input that is never coming.
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

// What the agent reads. The exit code is stated in words as well as in the number, because "exited 1" and
// "worked" are the two things it must not confuse, and on Windows a native program's failure does not stop the
// script, so the code is often the only evidence anything went wrong.
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
