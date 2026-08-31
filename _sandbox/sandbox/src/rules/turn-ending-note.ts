import type { Rule, TurnNote } from "@intentic/sandbox-contract";
import { standing } from "./rules.js";

export const TURN_ENDING_NOTE_HEADER = "## Automatic end-of-turn checks";
export const TURN_ENDING_NOTE_TITLE = "Automatic end-of-turn checks";

type CommandRule = Rule & { readonly action: Extract<Rule["action"], { kind: "command" }> };
const isCommandRule = (rule: Rule): rule is CommandRule => rule.action.kind === "command";

const whenSuffix = (rule: Rule): string => {
    if (rule.when === undefined) {
        return "";
    }
    const paths = rule.when.paths ?? [];
    return paths.length === 0 ? " (when its condition matches)" : ` (after edits to ${paths.map((glob) => `\`${glob}\``).join(" or ")})`;
};

/* Command rules run without the model's help, so naming them prevents duplicate checks. Built-ins and
 * instructions need model action and are deliberately omitted. */
export const turnEndingNote = (rules: readonly Rule[]): TurnNote | undefined => {
    const commands = standing(rules, "turn.ending").filter(isCommandRule);
    if (commands.length === 0) {
        return undefined;
    }
    return {
        title: TURN_ENDING_NOTE_TITLE,
        text: [
            TURN_ENDING_NOTE_HEADER,
            "",
            "These run automatically when you finish:",
            "",
            ...commands.map((rule) => `- **${rule.label}:** \`${rule.action.command}\`${whenSuffix(rule)}`),
            "",
            "Do not run or announce them yourself. Use targeted checks only when you need an earlier result.",
        ].join("\n"),
    };
};
