import { DEFAULT_SANDBOX_MODE, SANDBOX_MODES, type SandboxMode } from "@intentic/constants";
import { z } from "zod";
import type { Audience, Rule } from "./settings.js";

// HOW A SANDBOX RUNS (@intentic/constants sandbox-mode.ts), as its settings carry it and as both sides act on it.
//
// A hands-off sandbox owns the three rules that decide what becomes of finished work: it lands, it is saved as a
// version, and that version is backed up wherever a branch tracks a remote (a branch that tracks none is skipped by the
// push itself, so the third rule costs nothing until there is somewhere to send it). While the sandbox runs hands-off
// those rules stand, switched on, whatever a save or a hand edit says; the daemon's settings store applies that on
// every read and every write, so the land, the version and the push all read the same table the Agent tab shows.
// Switching back to hands-on changes no rule: what stood is the owner's from then on.

export const SandboxModeSchema = z.enum(SANDBOX_MODES);

export { DEFAULT_SANDBOX_MODE, type SandboxMode };

// The ids the Agent tab has always named these rules by (editor models/sandbox/environment/rules.ts), so a sandbox
// whose owner switched one on by hand before the mode existed keeps that very rule, and its firing history with it.
export const MANAGED_RULE_IDS = { land: "auto-land", version: "auto-version", push: "auto-push" } as const;

export type ManagedRule = keyof typeof MANAGED_RULE_IDS;

// The rules themselves, in the order they act. The labels are the English the Agent tab writes; it shows each by its
// own row, never by this label, which only a held-work line or an exported definition repeats.
const MANAGED = {
    land: {
        id: MANAGED_RULE_IDS.land,
        label: "Land finished work automatically",
        moment: "agent.finished",
        action: { kind: "verdict", verdict: "allow" },
        enabled: true,
    },
    version: {
        id: MANAGED_RULE_IDS.version,
        label: "Save a version of accepted work",
        moment: "agent.landed",
        action: { kind: "builtin", name: "version-landed" },
        enabled: true,
    },
    push: {
        id: MANAGED_RULE_IDS.push,
        label: "Back up each saved version",
        moment: "agent.landed",
        action: { kind: "builtin", name: "push-landed" },
        enabled: true,
    },
} satisfies Record<ManagedRule, Rule>;

const MANAGED_ORDER: readonly ManagedRule[] = ["land", "version", "push"];

// A copy, so a caller that edits what it was handed never edits the table.
export const managedRule = (which: ManagedRule): Rule => structuredClone(MANAGED[which]);

// Whether a rule already is the managed one: switched on, unconditioned, acting as the managed one acts. A rule under
// a managed id that the owner narrowed (a repository, some paths) is not: hands-off means every piece of finished work.
const standsAsManaged = (rule: Rule, which: ManagedRule): boolean =>
    rule.enabled && rule.when === undefined && rule.moment === MANAGED[which].moment && JSON.stringify(rule.action) === JSON.stringify(MANAGED[which].action);

/** Which managed rules a list lacks, has switched off, or has narrowed: what taking over would change, in acting order. */
export const handsOffChanges = (rules: readonly Rule[]): ManagedRule[] =>
    MANAGED_ORDER.filter((which) => {
        const held = rules.find((rule) => rule.id === MANAGED_RULE_IDS[which]);
        return held === undefined || !standsAsManaged(held, which);
    });

/**
 * A rule list as a hands-off sandbox runs it: the owner's own rules untouched, and each managed rule standing as the
 * managed one. One already in the list is replaced where it stands, so a hold the owner put ahead of it still decides
 * first; a missing one goes at the end. Answers the same array when nothing changes, so a reader can tell cheaply.
 */
export const handsOffRules = <T extends readonly Rule[]>(rules: T): T | Rule[] => {
    const changes = handsOffChanges(rules);
    if (changes.length === 0) {
        return rules;
    }
    const next = rules.map((rule) => {
        const which = MANAGED_ORDER.find((managed) => MANAGED_RULE_IDS[managed] === rule.id);
        return which !== undefined && changes.includes(which) ? managedRule(which) : rule;
    });
    for (const which of changes) {
        if (!next.some((rule) => rule.id === MANAGED_RULE_IDS[which])) {
            next.push(managedRule(which));
        }
    }
    return next;
};

/** The words a sandbox speaks to everyone who has not chosen for themselves. */
export const audienceOfMode = (mode: SandboxMode): Audience => (mode === "hands-off" ? "maker" : "developer");

/** The words one person reads: their own choice when they made one here, otherwise the sandbox's. */
export const effectiveAudience = (mode: SandboxMode, override: Audience | undefined): Audience => override ?? audienceOfMode(mode);
