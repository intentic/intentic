import type { Rule, RuleCondition, RuleMoment, RuleOutcome } from "@intentic/sandbox-contract";
import { globToRegExp } from "@intentic/iq-engine";

/* WHICH RULES STAND AT THIS MOMENT, the whole of rule resolution, and deliberately the whole of it in one
 * pure function over data the caller already has.
 *
 * There is no registry to populate and nothing to subscribe to: the owner's rules are a list in their settings,
 * a moment is a string, and the question "what applies here" is a filter. Three call sites ask it (the turn
 * that is ending, the push that is starting, the agent that has finished) and none of them needs anything the
 * others do not, so the seam between them is the argument list rather than an interface.
 *
 * WHAT "MATCHED NOTHING" MEANS is decided by the CALLER, not here, and that is the design's key
 * choice. An empty rule table has to reproduce the three settings this replaced, and those three defaulted
 * differently, no proof asked for, no command run, work held on its branch. Two of those are "do nothing" and
 * one is a decision, so a resolver that tried to own the default would have to know which moment it was
 * answering for. Instead `matching` returns what matched and `verdictOf` says what to do when nothing did. */

// HOW MANY RULES RUN AT ONE MOMENT, and it differs by what the moment is FOR, the one asymmetry in the table.
//
// A moment that DOES things runs everything that matches, in the owner's order: two commands before a push are
// two checks, and dropping the second because the first matched would be silent.
//
// A moment that DECIDES runs until something decides. `agent.finished` asks one question, does this land,
// and first-match-wins is what makes a narrow rule above a broad one mean anything. The list order IS the
// priority, which is why the settings screen lets rules be reordered and says so.
const decidesAt = (moment: RuleMoment): boolean => moment === "agent.finished";

const touches = (paths: readonly string[], globs: readonly string[]): boolean => {
    const patterns = globs.map(globToRegExp);
    return paths.some((path) => patterns.some((pattern) => pattern.test(path)));
};

/* Everything a condition can be asked about. Every field optional, because each moment knows a different
 * amount: a push knows the repo and the files, a finished agent knows how its turn ended, and a turn that is
 * ending knows what it edited. A condition naming a fact the moment does not carry does NOT match, the
 * alternative is a rule that silently widens to "always" at the one moment it was written to narrow. */
export interface RuleFacts {
    // The repos this occasion is ABOUT, plural because an agent's composition routinely spans several and a
    // rule naming one of them means "if this touches api", not "if this is only api".
    readonly repos?: readonly string[] | undefined;
    readonly paths?: readonly string[] | undefined;
    readonly outcome?: RuleOutcome | undefined;
}

export const conditionHolds = (when: RuleCondition | undefined, facts: RuleFacts): boolean => {
    if (when === undefined) {
        return true;
    }
    if (when.repo !== undefined && !(facts.repos ?? []).includes(when.repo)) {
        return false;
    }
    if (when.paths !== undefined && when.paths.length > 0 && !touches(facts.paths ?? [], when.paths)) {
        return false;
    }
    if (when.outcome !== undefined && when.outcome.length > 0 && (facts.outcome === undefined || !when.outcome.includes(facts.outcome))) {
        return false;
    }
    return true;
};

/* The enabled rules AT a moment, before anything is known about the particular occasion, armed, but not yet
 * asked whether they apply.
 *
 * This is the half `turn.ending` needs on its own. A turn is planned before it runs, so at planning time
 * nothing yet knows which files it will edit; the rules have to be carried into the turn and have their
 * conditions read at the Stop, against a ledger that by then knows. Resolving conditions early would quietly
 * turn every path condition on that moment into "never".
 *
 * A `command` rule with an empty command is dropped here rather than run as a no-op, because empty is how the
 * pre-push row has always said "off" and there is no second switch to disagree with it. Dropping it at
 * resolution means every consumer inherits that reading instead of each remembering to check. */
export const standing = (rules: readonly Rule[], moment: RuleMoment): Rule[] =>
    rules.filter((rule) => rule.enabled && rule.moment === moment && !(rule.action.kind === "command" && rule.action.command.trim() === ""));

// The rules standing at one moment whose condition also holds, in the owner's own order, what a caller that
// already knows the occasion asks for.
export const matching = (rules: readonly Rule[], moment: RuleMoment, facts: RuleFacts = {}): Rule[] => {
    const applicable = standing(rules, moment).filter((rule) => conditionHolds(rule.when, facts));
    return decidesAt(moment) ? applicable.slice(0, 1) : applicable;
};

/* Does finished work land by itself? The `agent.finished` moment's whole question, answered in one place so
 * the turn-completion path asks it rather than re-deriving it.
 *
 * HOLD IS THE ANSWER WHEN NOTHING MATCHED, and that is the old `autoLand: false` default arriving for free
 * rather than being restated: work held on its branch costs one press to release, work that landed unread has
 * to be noticed before it can be undone, and the empty table should pick the recoverable mistake.
 *
 * The per-agent override still wins over the table, an owner who pressed hold on one card meant that card.
 *
 * A TURN WHOSE OWN CHECK FAILED IS HELD, and that one holds against the override too. The `turn.ending` command
 * rule ran on this exact tree and went red, the model was told and could not repair it, and the fact rides here
 * as `outcome: "checks-failed"` (agent/turn-checks.ts). An override was pressed on a card before that check ever
 * ran, and an unconditional `allow` rule was written about work in general, so neither is a decision about red
 * work. The one thing that is, is a rule that names `checks-failed` in its condition: an owner who wrote that
 * meant it, and their verdict stands. Everything else waits on the branch as "Ready to land", which is the
 * recoverable mistake; red work that landed unread used to be found by the push gate, an hour and a click later,
 * and before that by CI. */
export const landingVerdict = (
    rules: readonly Rule[],
    facts: RuleFacts,
    override: boolean | undefined,
): { land: boolean; rule?: Rule; held?: "checks-failed" } => {
    if (facts.outcome === "checks-failed") {
        const rule = standing(rules, "agent.finished").find(
            (candidate) => candidate.when?.outcome?.includes("checks-failed") === true && conditionHolds(candidate.when, facts),
        );
        if (rule === undefined || rule.action.kind !== "verdict") {
            return { land: false, held: "checks-failed" };
        }
        return { land: rule.action.verdict === "allow", rule };
    }
    if (override !== undefined) {
        return { land: override };
    }
    const rule = matching(rules, "agent.finished", facts)[0];
    if (rule === undefined || rule.action.kind !== "verdict") {
        return { land: false };
    }
    return { land: rule.action.verdict === "allow", rule };
};
