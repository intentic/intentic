import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { agentCommand, toolResultText } from "../providers/agent-installs.js";

// Two PostToolUse-on-Bash notices, said once per turn, advisory only: the command already ran and its result stands. A
// standing prompt instruction decays as context grows (as browser-artifacts.ts found for screenshot paths), so a hook
// is what actually holds. Never rewrites the command: GNU grep's `\|` and ripgrep's differ, so a silent translation
// could return wrong results with no error.

// Cheap filters: a grep left of a pipe or with no -r is correct as written; only recursive is worth a word.
const FILTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cat", "cut", "awk", "sed", "tr", "jq", "grep", "rg"]);

const executableOf = (segment: string): string | undefined =>
    segment
        .trim()
        // Strips ordinary env assignments, `env`, `sudo`, and shell keywords that can lead a segment.
        .replace(/^(?:(?:then|do|else)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|env|sudo)\s+)*/, "")
        .split(/\s+/)[0]
        ?.split("/")
        .at(-1);

// Splits keeping the operators, since whether a segment was piped into is the whole false-positive guard; the capturing
// split interleaves [segment, operator, segment, ...], so the operator before segment i is at i-1.
const segmentsOf = (command: string): { text: string; pipedInto: boolean }[] => {
    const parts = command.split(/(\|\||&&|\||;|\n)/);
    const out: { text: string; pipedInto: boolean }[] = [];
    for (let index = 0; index < parts.length; index += 2) {
        const text = parts[index];
        if (text === undefined || text.trim() === "") {
            continue;
        }
        out.push({ text, pipedInto: parts[index - 1] === "|" });
    }
    return out;
};

// Flags are read off the flags, not the whole segment: `grep -n "foo -r bar" file` carries -r inside its pattern.
// Quoted runs are blanked first to remove that whole class of mistake.
const unquoted = (segment: string): string => segment.replace(/"[^"]*"|'[^']*'/g, '""');

// A recursive grep that is reading the filesystem rather than a pipe. `grep -rn`, `grep -R`, `grep --recursive`.
export const walksTreeWithGrep = (command: string): boolean =>
    segmentsOf(agentCommand(command)).some(
        (segment) =>
            !segment.pipedInto && executableOf(segment.text) === "grep" && /(?:^|\s)-(?:-recursive\b|\w*[rR])/.test(unquoted(segment.text)),
    );

// A search whose answer was really nothing: conservative on purpose, since a redirected, backgrounded, or chained
// command can print nothing while the search matched plenty.
export const searchCameBackEmpty = (command: string, result: string): boolean => {
    if (result.trim() !== "") {
        return false;
    }
    const unwrapped = agentCommand(command);
    if (/[>&]/.test(unwrapped.replace(/&&/g, ""))) {
        return false;
    }
    const segments = segmentsOf(unwrapped);
    let sawSearch = false;
    for (const segment of segments) {
        const executable = executableOf(segment.text);
        if (executable === undefined) {
            return false;
        }
        // `cd somewhere && rg …` is the ordinary shape and the `cd` prints nothing either way.
        if (executable === "cd" && !segment.pipedInto) {
            continue;
        }
        if (executable === "rg" && !segment.pipedInto) {
            sawSearch = true;
            continue;
        }
        if (segment.pipedInto && FILTERS.has(executable)) {
            continue;
        }
        return false;
    }
    return sawSearch;
};

const RIPGREP_NOTICE =
    "That `grep` walked the repository. `rg` (ripgrep) is installed here and answers the same search about 30× " +
    "faster, returning roughly a third of the bytes, because it skips node_modules, dist and binaries without " +
    "being told to. Use it for the rest of this turn. One gotcha when you translate: GNU grep reads `\\|` as " +
    "alternation and ripgrep reads it as a literal pipe, so write `|`, and `--include=*.ts` becomes `-g '*.ts'`.";

// Empty is itself an answer; automatic substitution would destroy that signal, since iq never returns nothing.
const IQ_NOTICE =
    "`rg` matched nothing, and that is itself an answer: this literal text is not in the tree, so do not keep " +
    "rephrasing the same pattern. If what you actually want is a CONCEPT rather than a string (\"where is X " +
    "decided\", \"how does Y work\"), `iq \"<your question>\"` searches by meaning and can find what no pattern " +
    "expresses. If you did mean the literal text, take the absence and move on.";

// Each flag is scoped once per turn (closure created per baseOptions), like the memories in agent-deps.ts; a later turn
// has drifted enough to be worth telling again.
export const searchNoticeHooks = (iqAvailable: boolean): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let toldRipgrep = false;
    let toldIq = false;
    return {
        PostToolUse: [
            {
                matcher: "Bash",
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const command = (input.tool_input as { command?: unknown }).command;
                        if (typeof command !== "string") {
                            return {};
                        }
                        if (!toldRipgrep && walksTreeWithGrep(command)) {
                            toldRipgrep = true;
                            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: RIPGREP_NOTICE } };
                        }
                        // Named only where iq is loaded: the setting defaults off with a holdout arm this would
                        // otherwise jump.
                        if (iqAvailable && !toldIq && searchCameBackEmpty(command, toolResultText(input.tool_response))) {
                            toldIq = true;
                            return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: IQ_NOTICE } };
                        }
                        return {};
                    },
                ],
            },
        ],
    };
};
