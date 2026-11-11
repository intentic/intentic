import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent, ToolCallStatus } from "@intentic/sandbox-contract/events/requests";
import { opt } from "../../../opt.js";
import { agentCommand, commandWords } from "../../providers/agent-installs.js";
import { checkOutcome, commandExitCode } from "../../verification/agent-verification.js";

/* WHICH OF A TURN'S COMMANDS FAILED, AND WHAT RAN CLEAN BESIDE THEM.

   Folded from the turn's frames, so it holds on every runtime alike: a shell call (`execute`) that failed or never
   started is kept with its exit, the line of its output that says why, and the command the same agent ran clean right
   after it (what it did instead). Beside the failures, every program that ran clean is counted, because a failure that
   stopped recurring can only be told from one nobody ran again by the clean runs since (logs/command-runs-log.ts). The
   settlement appends both to historyRoot/logs/command-runs.jsonl; nothing here reaches a prompt.

   Left out: a predicate answering no (`test -f`, `grep` with no match: exit 1 and nothing printed), a call the person
   interrupted, and a call still running when the turn ended. */

// How much one record keeps: the command as a line, the error as a line, and the end of what it printed.
const COMMAND_CHARS = 600;
const ERROR_CHARS = 240;
const TAIL_CHARS = 400;
// A turn that fails more than this is not giving more evidence per failure; `failed` still says how many there were.
const MAX_FAILURES = 40;
const MAX_PROGRAMS = 60;
// How far after a failure, in the same agent's shell calls, a clean run still reads as what it did instead.
const INSTEAD_WITHIN_CALLS = 3;

export interface CommandFailure {
    // As the agent wrote it, the terminal wrapper taken off; secret references stay references.
    readonly command: string;
    // `pnpm vitest`, `git push`, `python -m pytest`: what a failure is grouped by across conversations.
    readonly program: string;
    readonly exit?: number;
    // The shell never started the program (126, 127, "command not found"): the environment's failure, not the code's.
    readonly unstarted?: true;
    // The line of its output that says why, else its last line.
    readonly error: string;
    readonly tail: string;
    // Run by a subagent the turn started, rather than by the turn's own agent.
    readonly subagent?: true;
    // The next command the same agent ran clean within a few shell calls: what it did instead.
    instead?: string;
}

export interface CommandRuns {
    readonly failures: readonly CommandFailure[];
    // Failed shell calls, including any past MAX_FAILURES.
    readonly failed: number;
    // Program → clean runs this turn.
    readonly ran: Readonly<Record<string, number>>;
}

export interface CommandRunsFold {
    readonly note: (event: AgentEvent) => void;
    readonly reading: () => CommandRuns;
}

// Words that set up a command rather than being it.
const SETUP = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset", "true", ":", "echo", "printf", "sleep", "mkdir", "local"]);
// Words that run the next word: the program is what they run.
const WRAPPERS = new Set(["env", "time", "nice", "nohup", "sudo", "command", "exec", "timeout", "xargs"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A wrapper's own arguments: flags, durations, assignments.
const WRAPPER_ARG = /^(?:-|\d|[A-Za-z_][A-Za-z0-9_]*=)/;
// A verb worth keeping beside its program (`git push`, `pnpm vitest`), never a path, file or flag.
const VERB = /^[a-z][a-z0-9:_-]*$/i;

const nameOf = (word: string | undefined): string => word?.split("/").at(-1) ?? "";

const dropWhile = (words: readonly string[], drop: (word: string) => boolean): readonly string[] => {
    const kept = words.findIndex((word) => !drop(word));
    return kept === -1 ? [] : words.slice(kept);
};

// One invocation's words with leading assignments and wrappers (and their own arguments) taken off.
const invoked = (segment: readonly string[]): readonly string[] => {
    let words = dropWhile(segment, (word) => word === "" || ASSIGNMENT.test(word));
    while (WRAPPERS.has(nameOf(words[0]))) {
        words = dropWhile(words.slice(1), (word) => WRAPPER_ARG.test(word));
    }
    return words;
};

const programWords = (words: readonly string[]): string => {
    const [first, second, third] = words;
    const executable = nameOf(first);
    if (second === "-m" && third !== undefined) {
        return `${executable} -m ${third}`;
    }
    return second !== undefined && VERB.test(second) ? `${executable} ${second}` : executable;
};

/** The program a command runs, with its verb: the first invocation that is not setup, wrappers unwrapped. */
export const programOf = (command: string): string => {
    const words = commandWords(command)
        .map(invoked)
        .find((segment) => segment.length > 0 && !SETUP.has(nameOf(segment[0])));
    return words === undefined ? (command.trim().split(/\s+/)[0] ?? "") : programWords(words);
};

// The terminal wrapper's footer and a vendor's bare exit note say how it exited, which the record keeps as a number.
const FOOTER_LINE = /^---\s\[exit\s/;
const EXIT_NOTE = /^(?:exit\s+code|exited\s+with\s+code|exit\s+status)\s*:?\s*\d+\.?$/i;
const SAYS_WHY = /error|not found|denied|refused|no such|cannot|can't|couldn't|failed|fatal|exception|traceback|missing|invalid|unknown|timed? ?out|unable/i;

const outputLines = (text: string): string[] =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !FOOTER_LINE.test(line) && !EXIT_NOTE.test(line));

const textOf = (content: readonly ToolCallContent[] | undefined): string =>
    (content ?? []).flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

interface Pending {
    readonly command: string;
    // "" for the turn's own agent, else the subagent's spawning call.
    readonly actor: string;
}

interface Settled extends Pending {
    readonly status: "completed" | "failed";
    readonly text: string;
    readonly exitCode: number | undefined;
}

// The record of a settled call that failed; undefined for a predicate answering no.
const failureOf = (call: Settled, unstarted: boolean): CommandFailure | undefined => {
    const exit = call.exitCode ?? commandExitCode(call.text);
    const lines = outputLines(call.text);
    if (exit === 1 && lines.length === 0) {
        return undefined;
    }
    return {
        command: call.command.slice(0, COMMAND_CHARS),
        program: programOf(call.command),
        ...opt("exit", exit),
        ...opt("unstarted", unstarted ? (true as const) : undefined),
        error: (lines.find((line) => SAYS_WHY.test(line)) ?? lines.at(-1) ?? "").slice(0, ERROR_CHARS),
        tail: lines.join("\n").slice(-TAIL_CHARS),
        ...opt("subagent", call.actor === "" ? undefined : (true as const)),
    };
};

interface Open {
    readonly failure: CommandFailure;
    // The actor's shell-call count when it failed.
    readonly at: number;
}

export const createCommandRuns = (): CommandRunsFold => {
    const pending = new Map<string, Pending>();
    const failures: CommandFailure[] = [];
    const ran = new Map<string, number>();
    let failed = 0;
    // Per actor: shell calls settled so far, and its failures still waiting to learn what it did instead.
    const calls = new Map<string, number>();
    const open = new Map<string, Open[]>();

    const passed = (call: Settled, count: number): void => {
        const program = programOf(call.command);
        if (ran.has(program) || ran.size < MAX_PROGRAMS) {
            ran.set(program, (ran.get(program) ?? 0) + 1);
        }
        for (const entry of open.get(call.actor) ?? []) {
            if (count - entry.at <= INSTEAD_WITHIN_CALLS) {
                entry.failure.instead = call.command.slice(0, COMMAND_CHARS);
            }
        }
        open.delete(call.actor);
    };

    const fell = (call: Settled, count: number, unstarted: boolean): void => {
        const failure = failureOf(call, unstarted);
        if (failure === undefined) {
            return;
        }
        failed += 1;
        if (failures.length < MAX_FAILURES) {
            failures.push(failure);
            open.set(call.actor, [...(open.get(call.actor) ?? []), { failure, at: count }]);
        }
    };

    const settle = (id: string, status: ToolCallStatus | undefined, content: readonly ToolCallContent[] | undefined, exitCode?: number): void => {
        const call = pending.get(id);
        if (call === undefined || (status !== "completed" && status !== "failed")) {
            return;
        }
        pending.delete(id);
        const count = (calls.get(call.actor) ?? 0) + 1;
        calls.set(call.actor, count);
        const settled: Settled = { ...call, status, text: textOf(content), exitCode };
        const outcome = checkOutcome(settled);
        if (outcome === "passed") {
            passed(settled, count);
        } else {
            fell(settled, count, outcome === "unstarted");
        }
    };

    return {
        note: (event) => {
            if (event.kind === "tool_call_update") {
                settle(event.id, event.status, event.content, event.exitCode);
                return;
            }
            if (event.kind !== "tool_call" || event.category !== "execute" || event.target === undefined) {
                return;
            }
            pending.set(event.id, { command: agentCommand(event.target), actor: event.parentToolUseId ?? "" });
            settle(event.id, event.status, event.content);
        },
        reading: () => ({ failures: [...failures], failed, ran: Object.fromEntries(ran) }),
    };
};
