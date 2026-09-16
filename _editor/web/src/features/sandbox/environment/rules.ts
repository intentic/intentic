import type { Rule } from "@intentic/api-contract";
import type { RepoCheckMoment, RepoChecksSummary } from "@intentic/sandbox-contract";

// Pure functions over a rule list, no browser imports. Split from useRules.ts so the agent menu, chat notice and push
// dialog can read rules without pulling in a composable's queries. What the repositories themselves declare
// (useRepoChecks.ts) is read the same way and answered here, since a caller asking "is this push checked" has to ask
// both questions and should not have to know there were two.

// Rules with a dedicated row elsewhere on the tab; ids are this screen's own, not part of the wire contract.
export const NAMED_RULES = {
    verify: `verify-edits`,
    removals: `verify-removals`,
    viewing: `verify-ui-edits`,
    tests: `verify-tests`,
    prepush: `pre-push`,
    land: `auto-land`,
    version: `auto-version`,
} as const;

// The two rows a maker's arrival writes together: finished work lands on its own, and what lands is committed. Also
// what the Agent tab's own toggles write, so the two doors never disagree on the rule.
export const AUTO_LAND_RULE: Rule = {
    id: NAMED_RULES.land,
    label: `Land finished work automatically`,
    moment: `agent.finished`,
    action: { kind: `verdict`, verdict: `allow` },
    enabled: true,
};
export const AUTO_VERSION_RULE: Rule = {
    id: NAMED_RULES.version,
    label: `Save a version of accepted work`,
    moment: `agent.landed`,
    action: { kind: `builtin`, name: `version-landed` },
    enabled: true,
};

// Resolves what the rules say before anything about the occasion is known: the first unconditional rule matching a
// moment, since a conditional rule can't match the unknown.

// Whether finished work lands with no agent-specific rule in play; no match defaults to held.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};

/* WHAT STANDS BEFORE A PUSH OF THESE REPOSITORIES, in the order it runs. */
export const pushChecksOf = (rules: readonly Rule[], repos: readonly string[]): Rule[] =>
    rules.filter(
        (rule) =>
            rule.enabled &&
            rule.moment === `push.starting` &&
            rule.action.kind === `command` &&
            rule.action.command.trim() !== `` &&
            (rule.when?.repo === undefined || repos.includes(rule.when.repo)),
    );

/** Every repository whose own declared checks are running at this moment, narrowed to the repositories named. */
export const adoptedChecksFor = (declared: readonly RepoChecksSummary[], moment: RepoCheckMoment, inRepos?: readonly string[]): RepoChecksSummary[] =>
    declared.filter(
        (entry) => entry.adopted && (inRepos === undefined || inRepos.includes(entry.repo)) && entry.checks.some((check) => check.when === moment),
    );

// The command the flow names while it waits: the first one standing, because that is the one that actually runs first.
export const prepushCommandOf = (rules: readonly Rule[], repos: readonly string[] = []): string => {
    const first = pushChecksOf(rules, repos)[0];
    return first?.action.kind === `command` ? first.action.command : ``;
};
