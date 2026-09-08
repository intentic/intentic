import type { Rule, RuleMoment } from "@intentic/api-contract";
import type { IconName } from "@intentic/ui";

// Vocabulary shared by the rule form and the row that displays a rule, so a row never re-describes what the form
// wrote. Cost sits on each moment option; outcome is keyed by moment+action, since the same action means
// something different at each moment.

/** What a rule can be told to do, named for the effect; `hold`/`allow` are one action kind with two verdicts. */
export type Choice = `instruct` | `command` | `hold` | `allow`;

/** Everything but identity: the form writes the words, the list owns the id and enabled state. */
export type RuleDraft = Omit<Rule, `id` | `enabled`>;

interface MomentWords {
    readonly value: RuleMoment;
    readonly label: string;
    readonly icon: IconName;
    /** How often this moment costs something, read at choice time. */
    readonly cost: string;
}

// Non-empty by type: callers always get a first moment and a first action without checking for undefined.
export const MOMENTS: readonly [MomentWords, ...MomentWords[]] = [
    { value: `file.edited`, label: `After it edits a file`, icon: `pencil`, cost: `Once per edited file` },
    { value: `turn.ending`, label: `Before the assistant finishes`, icon: `clock`, cost: `Once per turn` },
    { value: `push.starting`, label: `Before you push`, icon: `cloud-upload`, cost: `Once per push` },
    { value: `agent.finished`, label: `When an agent finishes`, icon: `robot`, cost: `Once per finished agent` },
];

interface ActionWords {
    readonly value: Choice;
    /** Short enough to be a pill label, not an explanation. */
    readonly label: string;
    /** The one sentence shown for the chosen action, explaining what actually happens. */
    readonly outcome: string;
}

// Only actions the daemon schema accepts at a moment are offered, so saving can't fail after the fact.
export const ACTIONS: Record<RuleMoment, readonly [ActionWords, ...ActionWords[]]> = {
    "file.edited": [
        {
            value: `command`,
            label: `Run a command`,
            outcome: `Runs on the file it just wrote, with {file} standing for the path. If it fails, its output goes back with the edit, while the file is still in mind.`,
        },
    ],
    "turn.ending": [
        {
            value: `instruct`,
            label: `Tell it something`,
            outcome: `The assistant is told this before it stops, and carries on to act on it.`,
        },
        {
            value: `command`,
            label: `Run a command`,
            outcome: `It has to pass. If it fails, its output goes back to the assistant to repair before finishing.`,
        },
    ],
    "push.starting": [
        {
            value: `command`,
            label: `Run a command`,
            outcome: `The push waits on it. Pass and it goes; fail and it does not, and you get the output.`,
        },
    ],
    "agent.finished": [
        { value: `hold`, label: `Hold the work`, outcome: `Its work stays on its branch until you land it yourself.` },
        { value: `allow`, label: `Land the work`, outcome: `Its work lands in your workspace as soon as the agent finishes.` },
    ],
};

export const momentOf = (moment: RuleMoment): MomentWords => MOMENTS.find((entry) => entry.value === moment) ?? MOMENTS[0];

// Splits on commas or whitespace: a comma-separated and a space-separated list are the same intention.
export const globsOf = (text: string): string[] => text.split(/[\s,]+/).filter((glob) => glob !== ``);

// Clips to the daemon's 80-character label limit, breaking on a word boundary when possible.
const clip = (text: string, at = 56): string => {
    const tidy = text.replace(/\s+/g, ` `).trim();
    if (tidy.length <= at) {
        return tidy;
    }
    const space = tidy.lastIndexOf(` `, at);
    return `${tidy.slice(0, space > at / 2 ? space : at)}…`;
};

// Derives a name from what was typed, since asking for one before there's anything to name gets a bad answer.
// Verdicts have no words of their own, so they borrow the narrowing paths instead.
export const nameOf = (action: Choice, command: string, text: string, paths: readonly string[]): string => {
    if (action === `command`) {
        return clip(command);
    }
    if (action === `instruct`) {
        return clip(text.replace(/[.!?]+$/, ``));
    }
    const touching = paths.length > 0 ? ` touching ${paths.join(`, `)}` : ``;
    return clip(`${action === `allow` ? `Land` : `Hold`} finished work${touching}`);
};
