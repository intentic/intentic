import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { agentCommand, toolResultText } from "./agent-installs.js";

/* SHELL SEARCH HYGIENE, SAID AT THE MOMENT IT IS EARNED AND ONCE PER TURN.
 *
 * Two notices, one trigger apiece, both PostToolUse on Bash, and both deliberately advisory: the command has
 * already run and its answer is already correct. What is wrong is which binary ran, or what the agent is about
 * to conclude from an empty answer.
 *
 * WHY A HOOK AND NOT ONLY THE PROMPT. Both facts are also in the system prompt (system-prompt.ts,
 * SEARCH_GUIDANCE), and the prompt demonstrably works on a fresh turn: in a paired trial, two task sets run
 * with and without that sentence, the treated arm used `rg` for all 16 of its searches and the control used
 * `grep -r` for 13 and `rg` for none, at 13% more tokens and 11% more wall time for the same answers. But a
 * standing instruction decays as context grows, and this repository already has the proof: browser-artifacts.ts
 * documents the same sentence about screenshot paths being in the prompt, believed by one session and ignored
 * by the next, which is why that path is dictated by a hook. This is the cheaper half of the same lesson, and
 * the two compose, the prompt gets it right before the first search, the hook catches the drift.
 *
 * WHY IT NEVER REWRITES THE COMMAND. browser-artifacts.ts can rewrite a filename because a path means the same
 * thing wherever it is resolved. A regex does not: GNU grep reads `\|` as alternation, ripgrep's Rust engine
 * reads it as a literal pipe, so `grep -rn 'a\|b'` and `rg 'a\|b'` return different things and 9,923 commands in
 * the transcript corpus are written the GNU way. A silent translation would hand back wrong results with no
 * error anywhere, which is worse than the slow command it replaced. So this tells, and the agent decides. */

// Cheap filters. A grep on the right of a pipe is reading a command's output and is correct as written; a grep
// with no -r is reading a named file. Only a recursive grep walks the tree, and only that is worth a word.
const FILTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cat", "cut", "awk", "sed", "tr", "jq", "grep", "rg"]);

const executableOf = (segment: string): string | undefined =>
    segment
        .trim()
        // ordinary env assignments, `env`, `sudo`, and shell keywords that can lead a segment
        .replace(/^(?:(?:then|do|else)\s+)?(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+|env|sudo)\s+)*/, "")
        .split(/\s+/)[0]
        ?.split("/")
        .at(-1);

/* Split keeping the operators, because whether a segment was PIPED INTO is the whole false-positive guard.
 * `split` with a capturing group interleaves [segment, operator, segment, …], so the operator before segment i
 * is at i-1. */
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

/* The flag has to be read off the FLAGS, not off the whole segment: `grep -n "foo -r bar" file` carries the
 * letters of a recursive search inside its pattern and walks nothing. Quoted runs are blanked first, which
 * costs one replace and removes the entire class of that mistake. */
const unquoted = (segment: string): string => segment.replace(/"[^"]*"|'[^']*'/g, '""');

// A recursive grep that is reading the filesystem rather than a pipe. `grep -rn`, `grep -R`, `grep --recursive`.
export const walksTreeWithGrep = (command: string): boolean =>
    segmentsOf(agentCommand(command)).some(
        (segment) =>
            !segment.pipedInto && executableOf(segment.text) === "grep" && /(?:^|\s)-(?:-recursive\b|\w*[rR])/.test(unquoted(segment.text)),
    );

/* A search whose ANSWER WAS NOTHING, and which we can be sure really did answer nothing.
 *
 * Conservative on purpose: a command that redirects, backgrounds, or goes on to run something else can print
 * nothing while the search itself matched plenty, and a notice fired on that would teach the agent to distrust
 * a correct empty result. So the shape has to be a search and its filters, and nothing more. */
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

/* WHAT AN EMPTY ripgrep MEANS, and why this stops short of running anything.
 *
 * Measured on 400 searches replayed from the corpus: ripgrep comes back empty on 22% of them, and iq, asked the
 * same query, surfaces the file the agent actually wanted in 31.8% of those. Running it automatically was the
 * obvious move and is the wrong one: iq never returns nothing by design, so the other 68.2% of firings answer
 * with ten plausible files and none of them right. Empty IS information, the string is not in the tree, and an
 * automatic substitution destroys that signal two times in three while looking identical to a rescue.
 *
 * So the note costs no latency and runs no search. It says what the empty result already proved, and names the
 * tool that answers the other kind of question. The agent, which knows which kind it was asking, decides.
 *
 * IT IS DORMANT TODAY, and that is expected rather than broken. Replayed over the whole corpus this fires zero
 * times, because there are only 676 `rg` invocations in it and not one of them came back empty: agents reach for
 * ripgrep late, after they have already narrowed, and reach for `grep` the other 25,689 times. The 22% figure
 * above is from grep-shaped queries REPLAYED through rg, not from live rg calls. This notice becomes worth its
 * lines only as the steer above it moves searches onto rg, and it costs nothing in the meantime. */
const IQ_NOTICE =
    "`rg` matched nothing, and that is itself an answer: this literal text is not in the tree, so do not keep " +
    "rephrasing the same pattern. If what you actually want is a CONCEPT rather than a string (\"where is X " +
    "decided\", \"how does Y work\"), `iq \"<your question>\"` searches by meaning and can find what no pattern " +
    "expresses. If you did mean the literal text, take the absence and move on.";

/* Created once per turn (baseOptions), which is what these two flags are scoped to, exactly like the memories in
 * agent-deps.ts. Once per TURN rather than once per session is what the closure gives for free, and it is also
 * the right unit: 51.1% of turns in the corpus contain at least one repo-walking grep, a median of 4 of them
 * and a p90 of 15, so the cap removes 85% of the firings (8,236 down to 1,275) and with them the nagging that
 * would make the notice read as noise. A later turn has drifted far enough to be worth telling again. */
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
                        // Named only where the iq plugin is actually loaded: the setting defaults off and carries a
                        // holdout arm (turn-plan.ts), so advertising it here would jump the gate and put the tool's
                        // name in front of the control group that exists to run without it.
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
