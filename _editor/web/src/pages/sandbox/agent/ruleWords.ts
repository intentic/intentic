import type { Rule, RuleMoment } from "@intentic-app/api-contract";
import type { IconName } from "@intentic/ui";

/* THE WORDS A RULE IS WRITTEN IN, one vocabulary, read by the form that writes a rule and by the row that
 * shows one back.
 *
 * They used to be two tables in one component, and the risk was always the same: a row that describes itself
 * differently from the form that made it is a row nobody trusts. Here the row re-describes nothing. It renders
 * the same labels, out of the same arrays, in the order the form asked for them.
 *
 * WHAT A MOMENT COSTS rides the option rather than a caption under the closed picker, because the only time
 * the cost matters is while you are choosing between them. Today all three are cheap (once a turn, once a push,
 * once an agent), but the whole point of this table is that moments get added, and the first hot one would
 * otherwise arrive as a trap with a friendly picker in front of it.
 *
 * WHAT A RULE THEN DOES is said once, at the pair, because the same "run a command" means something different
 * at each moment. A failing command before a turn ends sends the assistant back to repair it; the same command
 * before a push simply stops the push. One line, keyed by both halves, is the only honest way to say that. */

/** What a rule can be told to do, named for the effect. `hold`/`allow` are one action kind with two verdicts,
 *  and nobody choosing between them is thinking that. */
export type Choice = `instruct` | `command` | `hold` | `allow`;

/** Everything but identity: the form writes the words, the list owns the id and whether the rule is on. */
export type RuleDraft = Omit<Rule, `id` | `enabled`>;

interface MomentWords {
    readonly value: RuleMoment;
    readonly label: string;
    readonly icon: IconName;
    /** How often standing here costs something, read while choosing, not afterwards. */
    readonly cost: string;
}

// Non-empty by type, so "the moment this rule stands at" never has to be answered with `undefined`, there is
// always a first moment and always a first action, and every caller would otherwise re-prove it.
export const MOMENTS: readonly [MomentWords, ...MomentWords[]] = [
    { value: `file.edited`, label: `After it edits a file`, icon: `pencil`, cost: `Once per edited file` },
    { value: `turn.ending`, label: `Before the assistant finishes`, icon: `clock`, cost: `Once per turn` },
    { value: `push.starting`, label: `Before you push`, icon: `cloud-upload`, cost: `Once per push` },
    { value: `agent.finished`, label: `When an agent finishes`, icon: `robot`, cost: `Once per finished agent` },
];

interface ActionWords {
    readonly value: Choice;
    /** Short enough to be a pill: this is the choice, not the explanation. */
    readonly label: string;
    /** What actually happens when the rule fires here. The one sentence the form spends a grey line on. */
    readonly outcome: string;
}

/* Which actions fit which moment is not a matter of taste, a verdict at a turn's end has nothing to decide,
 * and the daemon's own schema refuses the pair. Offering only what will save keeps the refusal from arriving
 * after the user has typed. */
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

// The globs someone typed, however they typed them. Splitting on whitespace as well as commas is not
// tolerance for its own sake: two globs separated by a comma and the same two separated by a space are the
// same intention, and the old comma-only split turned the second into ONE glob that matches nothing,
// silently, and only visible weeks later as a rule that had never fired.
export const globsOf = (text: string): string[] => text.split(/[\s,]+/).filter((glob) => glob !== ``);

// A label has to fit the daemon's 80, and a name nobody reads to the end is no name.
const clip = (text: string, at = 56): string => {
    const tidy = text.replace(/\s+/g, ` `).trim();
    if (tidy.length <= at) {
        return tidy;
    }
    const space = tidy.lastIndexOf(` `, at);
    return `${tidy.slice(0, space > at / 2 ? space : at)}…`;
};

/* WHAT THE RULE CALLS ITSELF. The old form asked for a name FIRST and refused to save without one, which is
 * the one question nobody can answer before they have said what the rule does, so it was answered badly, or
 * it was the reason the button stayed grey.
 *
 * The command or the instruction IS the name people would have typed, so it is offered as one and the box
 * becomes a footnote you may overwrite. Verdicts have no words of their own, so they borrow the narrowing. */
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
