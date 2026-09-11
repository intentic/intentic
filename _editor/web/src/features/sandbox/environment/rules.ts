import type { Rule } from "@intentic/api-contract";
import type { RepoChecksSummary } from "@intentic/sandbox-contract";

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
} as const;

// Resolves what the rules say before anything about the occasion is known: the first unconditional rule matching a
// moment, since a conditional rule can't match the unknown.

// Whether finished work lands with no agent-specific rule in play; no match defaults to held.
export const landsByDefault = (rules: readonly Rule[]): boolean => {
    const deciding = rules.find((rule) => rule.enabled && rule.moment === `agent.finished` && rule.when === undefined);
    return deciding?.action.kind === `verdict` && deciding.action.verdict === `allow`;
};

/* WHAT STANDS BEFORE A PUSH OF THESE REPOSITORIES, in the order it runs. A rule naming no repository stands for every
 * push; one naming a repository stands only when that repository is going out, which is the whole point of naming it.
 * `repos` empty is a push of nothing in particular and leaves only the unconditional rules, matching what the daemon
 * runs when the caller names none. */
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
export const adoptedChecksFor = (declared: readonly RepoChecksSummary[], moment: "turn" | "push", inRepos?: readonly string[]): RepoChecksSummary[] =>
    declared.filter(
        (entry) => entry.adopted && (inRepos === undefined || inRepos.includes(entry.repo)) && entry.checks.some((check) => check.when === moment),
    );

// The command the flow names while it waits: the first one standing, because that is the one that actually runs first.
export const prepushCommandOf = (rules: readonly Rule[], repos: readonly string[] = []): string => {
    const first = pushChecksOf(rules, repos)[0];
    return first?.action.kind === `command` ? first.action.command : ``;
};
