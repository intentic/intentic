import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { agentCommand } from "../providers/agent-installs.js";

// A PostToolUse-on-Bash notice, said once per turn, advisory only: the command already ran and its result stands. A
// standing prompt instruction decays as context grows (as browser-artifacts.ts found for screenshot paths), so a hook
// is what actually holds. Never rewrites the command: GNU grep's `\|` and ripgrep's differ, so a silent translation
// could return wrong results with no error.

// A grep left of a pipe or with no -r is correct as written; only recursive is worth a word.

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

const RIPGREP_NOTICE =
    "That `grep` walked the repository. `rg` (ripgrep) is installed here and answers the same search about 30× " +
    "faster, returning roughly a third of the bytes, because it skips node_modules, dist and binaries without " +
    "being told to. Use it for the rest of this turn. One gotcha when you translate: GNU grep reads `\\|` as " +
    "alternation and ripgrep reads it as a literal pipe, so write `|`, and `--include=*.ts` becomes `-g '*.ts'`.";

// Each flag is scoped once per turn (closure created per baseOptions), like the memories in agent-deps.ts; a later turn
// has drifted enough to be worth telling again.
export const searchNoticeHooks = (): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    let toldRipgrep = false;
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
                        return {};
                    },
                ],
            },
        ],
    };
};
