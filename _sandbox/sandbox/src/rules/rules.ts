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
    // One uniform draw in [0, 1) per occasion, for a rule that fires on a sample; a moment that draws none never samples.
    readonly draw?: number | undefined;
}

const repoHolds = (when: RuleCondition, facts: RuleFacts): boolean => when.repo === undefined || (facts.repos ?? []).includes(when.repo);

// Which repositories a set of workspace-relative paths falls in, for the moments that know paths but not repos (a turn
// ending knows what it edited, not where each file belongs). The longest id wins, since a nested repository is its own
// and not its parent's; anything under none of them belongs to the workspace's own repository, "root".
export const reposOf = (paths: readonly string[], repos: readonly string[]): string[] => {
    // Longest first, so `extensions/logs` is preferred over `extensions` without comparing lengths per candidate.
    const ordered = [...repos].sort((left, right) => right.length - left.length);
    const found = new Set<string>();
    for (const path of paths) {
        found.add(ordered.find((repo) => path === repo || path.startsWith(`${repo}/`)) ?? "root");
    }
    return [...found];
};
const pathsHold = (when: RuleCondition, facts: RuleFacts): boolean =>
    when.paths === undefined || when.paths.length === 0 || touches(facts.paths ?? [], when.paths);
const outcomeHolds = (when: RuleCondition, facts: RuleFacts): boolean =>
    when.outcome === undefined || when.outcome.length === 0 || (facts.outcome !== undefined && when.outcome.includes(facts.outcome));
// A moment that draws nothing never samples: a sampled rule at the push or the landing decision fires every time.
const sampleHolds = (when: RuleCondition, facts: RuleFacts): boolean => when.sample === undefined || facts.draw === undefined || facts.draw < when.sample;

export const conditionHolds = (when: RuleCondition | undefined, facts: RuleFacts): boolean =>
    when === undefined || (repoHolds(when, facts) && pathsHold(when, facts) && outcomeHolds(when, facts) && sampleHolds(when, facts));

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
