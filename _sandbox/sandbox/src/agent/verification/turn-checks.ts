import type { Rule, RuleOutcome } from "@intentic/sandbox-contract";
import type { RuleCommandRun } from "../../rules/rule-command.js";

// The turn-ending check's verdict, carried from the Stop that ran it to the land that reads it; without this the land
// sees only repo/path facts, not the check. The conversation's actor holds it for exactly one land, which takes it, so
// a turn that never landed can't decide the next one's fate.
export interface CheckVerdict {
    readonly ruleId: string;
    readonly label: string;
    readonly command: string;
    readonly status: RuleCommandRun["status"];
    readonly at: number;
}

// One run of a turn.ending check, as the conversation is told it: `command` only for a command rule, the one kind
// whose run is a verdict a land can read.
export interface CheckRun {
    readonly ruleId: string;
    readonly label: string;
    readonly command?: string;
    readonly status: RuleCommandRun["status"];
}

export const checkRunOf = (rule: Rule, run: RuleCommandRun): CheckRun => ({
    ruleId: rule.id,
    label: rule.label,
    ...(rule.action.kind === "command" ? { command: rule.action.command } : {}),
    status: run.status,
});

// How a clean turn ended, from the landing's own facts. Only a settled failure counts: `error` (never ran) and
// `cancelled` both measured nothing, and read the same as a turn with no command rule at all.
export const landingOutcome = (verdict: CheckVerdict | undefined): RuleOutcome => (verdict?.status === "failed" ? "checks-failed" : "clean");
