import type { Rule, RuleOutcome } from "@intentic/sandbox-contract";
import type { RuleCommandRun } from "../../rules/rule-command.js";

// The turn-ending check's verdict, carried from the Stop that ran it to the land that reads it; without this the land
// sees only repo/path facts, not the check. In-memory and per-conversation for exactly one land; `take` clears on read
// so a turn that never landed can't decide the next one's fate.
export interface CheckVerdict {
    readonly ruleId: string;
    readonly label: string;
    readonly command: string;
    readonly status: RuleCommandRun["status"];
    readonly at: number;
}

const verdicts = new Map<string, CheckVerdict>();

// The last verdict wins: a check that failed at the first Stop and passed after a repair is a turn whose work passed.
export const recordCheckVerdict = (conversationId: string, rule: Rule, run: RuleCommandRun): void => {
    if (rule.action.kind !== "command") {
        return;
    }
    verdicts.set(conversationId, { ruleId: rule.id, label: rule.label, command: rule.action.command, status: run.status, at: Date.now() });
};

export const takeCheckVerdict = (conversationId: string): CheckVerdict | undefined => {
    const verdict = verdicts.get(conversationId);
    verdicts.delete(conversationId);
    return verdict;
};

// How a clean turn ended, from the landing's own facts. Only a settled failure counts: `error` (never ran) and
// `cancelled` both measured nothing, and read the same as a turn with no command rule at all.
export const landingOutcome = (verdict: CheckVerdict | undefined): RuleOutcome => (verdict?.status === "failed" ? "checks-failed" : "clean");
