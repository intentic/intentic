import type { Rule, RuleCondition, RuleMoment, RuleOutcome } from "@intentic/sandbox-contract";
import { globToRegExp } from "@intentic/iq-engine";

// Rule resolution is a pure function over data the caller already has: no registry, the owner's rules are a list in
// settings. `matching` returns what matched; the caller decides what an empty result means, since each moment's default
// (land, hold, or nothing) differs.

// Rule count per moment differs by purpose: one that does things (a push check) runs every match, in order; one that
// decides (agent.finished) runs until a rule decides, first match wins, list order is the priority owners can reorder.
const decidesAt = (moment: RuleMoment): boolean => moment === "agent.finished";

const touches = (paths: readonly string[], globs: readonly string[]): boolean => {
    const patterns = globs.map(globToRegExp);
    return paths.some((path) => patterns.some((pattern) => pattern.test(path)));
};

// Every field optional: a moment supplies only what it knows, and a condition naming a fact the moment lacks does not
// match.
export interface RuleFacts {
    // Plural: an occasion can span several repos; naming one matches if it's touched, not if it's the only one.
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

// Enabled rules at a moment, before conditions are checked; turn.ending carries these in since path facts aren't known
// until the Stop. An empty `command` rule is dropped here, not a no-op: empty has always meant off.
export const standing = (rules: readonly Rule[], moment: RuleMoment): Rule[] =>
    rules.filter((rule) => rule.enabled && rule.moment === moment && !(rule.action.kind === "command" && rule.action.command.trim() === ""));

// The rules standing at one moment whose condition also holds, in the owner's order; what a caller that already knows
// the occasion asks for.
export const matching = (rules: readonly Rule[], moment: RuleMoment, facts: RuleFacts = {}): Rule[] => {
    const applicable = standing(rules, moment).filter((rule) => conditionHolds(rule.when, facts));
    return decidesAt(moment) ? applicable.slice(0, 1) : applicable;
};

// Whether finished work lands; an empty table holds by default, and a per-agent override wins over the table unless the
// turn's own check failed, when only a rule naming `checks-failed` may allow it.
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
