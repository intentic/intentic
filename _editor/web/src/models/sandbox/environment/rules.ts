import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { t } from "@intentic/ui/i18n";

// Pure functions over a rule list, no browser imports, so the agent menu and chat notice read rules without
// useRules.ts's queries.

// Rules with a dedicated row on the Agent tab; ids are this screen's own, not part of the wire contract.
export const NAMED_RULES = {
    land: `auto-land`,
    version: `auto-version`,
    push: `auto-push`,
} as const;

// The two rows a maker's arrival can opt into together: finished work lands on its own, and what lands is committed.
// Also what the Agent tab's own toggles write, so the two doors never disagree on the rule.
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

// What each saved version committed, pushed to the remote branch it tracks (the daemon's conversations/land/settle/push-landed.ts).
// Only ever after the version above: it pushes a commit a land made, so the Agent tab offers it beside that row alone.
export const autoPushRule = (): Rule => ({
    id: NAMED_RULES.push,
    label: t(`sandbox.agentFinishedWork.backUpSaved`),
    moment: `agent.landed`,
    action: { kind: `builtin`, name: `push-landed` },
    enabled: true,
});

// Resolves what the rules say before anything about the occasion is known: the first unconditional rule matching a
// moment, since a conditional rule can't match the unknown.

// Whether finished work lands with no agent-specific rule in play; no match defaults to held.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};
