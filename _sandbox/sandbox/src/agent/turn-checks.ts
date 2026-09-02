import type { Rule, RuleOutcome } from "@intentic/sandbox-contract";
import type { RuleCommandRun } from "../rules/rule-command.js";

/* WHAT THE TURN'S OWN CHECK SAID, carried from the Stop that ran it to the land that should read it.
 *
 * A `turn.ending` command rule runs when the model tries to finish (rules/turn-ending.ts). Its verdict went one
 * place: back to the model, as a follow-up. The land at the end of the same turn (agent/agent.routes.ts) then
 * asked the `agent.finished` rules whether the work reaches the tree, with facts about repos and paths and none
 * about the check, so a turn whose `pnpm verify` went red and whose model answered "cannot be repaired here"
 * ended `clean` and landed. The gate that caught that was the push, an hour and an owner's click later, and
 * before the push gate ran what CI runs, it was CI.
 *
 * So the verdict is kept here, per conversation, for exactly one land. In memory and process-scoped on purpose:
 * it is about the turn that is ending right now, a daemon restart mid-turn ends that turn without a land, and
 * nothing later should read a verdict about work that has since moved on. `take` clears as it reads, which is
 * what stops a verdict from a turn that erred (and so never landed) from deciding the next turn's fate. */
export interface CheckVerdict {
    readonly ruleId: string;
    readonly label: string;
    readonly command: string;
    readonly status: RuleCommandRun["status"];
    readonly at: number;
}

const verdicts = new Map<string, CheckVerdict>();

// The LAST verdict wins: a check that failed at the first Stop and was re-run green after the repair is a turn
// whose work passed, and the follow-up loop (rules/turn-ending.ts) exists to produce exactly that sequence.
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

/* How a clean turn ended, as the landing facts say it. Only a SETTLED failure speaks: `error` means the command
 * never ran (no shell, an unreadable cwd) and `cancelled` means someone stopped it, and both measured nothing
 * about the work. A fact about nothing must neither hold nor release it, so those read as a clean turn, the
 * same answer a turn with no command rule at all gets. */
export const landingOutcome = (verdict: CheckVerdict | undefined): RuleOutcome => (verdict?.status === "failed" ? "checks-failed" : "clean");
