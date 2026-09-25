import type { Rule } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";

// Pure functions over a rule list, no browser imports, so the agent menu and chat notice read rules without
// useRules.ts's queries.

// Rules with a dedicated row on the Agent tab; ids are this screen's own, not part of the wire contract.
export const NAMED_RULES = {
    land: `auto-land`,
    version: `auto-version`,
} as const;

// The two rows a maker's arrival writes together: finished work lands on its own, and what lands is committed. Also
// what the Agent tab's own toggles write, so the two doors never disagree on the rule.
export const autoLandRule = (): Rule => ({
    id: NAMED_RULES.land,
    label: t(`sandbox.words.landFinishedWorkAutomatically`),
    moment: `agent.finished`,
    action: { kind: `verdict`, verdict: `allow` },
    enabled: true,
});
export const autoVersionRule = (): Rule => ({
    id: NAMED_RULES.version,
    label: t(`sandbox.words.saveVersionAcceptedWork`),
    moment: `agent.landed`,
    action: { kind: `builtin`, name: `version-landed` },
    enabled: true,
});

// Resolves what the rules say before anything about the occasion is known: the first unconditional rule matching a
// moment, since a conditional rule can't match the unknown.

// Whether finished work lands with no agent-specific rule in play; no match defaults to held.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};
