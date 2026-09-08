import type { Rule } from "@intentic/api-contract";

// Pure functions over a rule list, no browser imports. Split from useRules.ts so the agent menu, chat notice and push
// dialog can read rules without pulling in a composable's queries.

// Rules with a dedicated row elsewhere on the tab; ids are this screen's own, not part of the wire contract.
export const NAMED_RULES = {
    verify: `verify-edits`,
    removals: `verify-removals`,
    viewing: `verify-ui-edits`,
    tests: `verify-tests`,
    prepush: `pre-push`,
    land: `auto-land`,
} as const;

// Resolves what the rules say before anything about the occasion is known: the first unconditional rule matching a
// moment, since a conditional rule can't match the unknown.

// Whether finished work lands with no agent-specific rule in play; no match defaults to held.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};

// The first enabled push-starting command rule; first because that's the one that actually runs first.
export const prepushCommandOf = (rules: readonly Rule[]): string => {
    for (const rule of rules) {
        if (rule.enabled && rule.moment === `push.starting` && rule.action.kind === `command` && rule.action.command.trim() !== ``) {
            return rule.action.command;
        }
    }
    return ``;
};
