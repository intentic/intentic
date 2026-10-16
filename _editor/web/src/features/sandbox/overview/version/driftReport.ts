import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { appBehind, daemonBehind, driftedRoutes, missingRoutes, unknownDaemonRoutes } from "../../../../client/sandbox/useDaemonRoutes";
import { type AreaName, namedArea, routeGroup } from "../../../../client/sandbox/daemon/routeAreas";

// WHO IS FAILING TO TALK TO WHOM, IN WORDS SOMEONE WHO DID NOT WRITE THIS WOULD USE. The raw diff is three lists of
// dotted route names (`agent.send`, `sessions.list`), which on its own says "7 routes disagree" — a sentence about the
// mechanism and about nothing a reader can act on. Every string below is the plain-English half: what broke, what it
// will look like when it bites, and which part of the app it is in. The dotted names stay, one chevron away, for
// whoever goes and fixes it.
//
// No "route", "call", "endpoint", "contract", "schema" or "daemon" in anything a reader sees. Those are the words that
// made the first version of this card unreadable to everyone who had not written it.

// The three ways two builds fail to meet, worst first. They are genuinely different failures and no single sentence
// covers them: one call is absent, one is present with different fields, one exists on a side that can't ask for it.
export type DriftKind = "missing" | "drifted" | "extra";

// Ranked by how much of an area it takes away: an absent call is that feature gone here; a drifted one still answers
// and lies; an extra one costs nothing but an unused capability.
const KIND_RANK: Readonly<Record<DriftKind, number>> = { missing: 0, drifted: 1, extra: 2 };

export interface DriftArea {
    // Contract group the routes came from, which is also the row's key.
    readonly key: string;
    readonly label: string;
    // Where in the app the reader would be standing when this bites; a Row description, so one short line.
    readonly where: string;
    readonly missing: readonly string[];
    readonly drifted: readonly string[];
    readonly extra: readonly string[];
    // The worst kind this area holds, which decides its glyph and how the row is read.
    readonly kind: DriftKind;
    readonly count: number;
}

// A group with no entry in the table (routeAreas.ts) is one of two different things, and saying the wrong one misleads:
// a group only the DAEMON named is a feature this build predates, while one of our own (every missing or drifted route
// is a call this build makes) is simply an area the table has no plain name for — which the hand-written routes,
// grouped by their path, bring more of.
const nameOf = (key: string, theirsOnly: boolean): AreaName =>
    namedArea(key) ?? {
        label: key.charAt(0).toUpperCase() + key.slice(1),
        where: theirsOnly ? t(`sandbox.driftReport.unknownWhere`) : t(`sandbox.driftReport.unnamedWhere`),
    };

// Folds three flat route lists into one row per area of the product. Pure, so the whole table above is testable
// without a daemon.
export const driftAreas = (lists: {
    missing: readonly string[];
    drifted: readonly string[];
    extra: readonly string[];
}): readonly DriftArea[] => {
    const byKey = new Map<string, { missing: string[]; drifted: string[]; extra: string[] }>();
    const file = (kind: DriftKind, routes: readonly string[]): void => {
        for (const route of routes) {
            const key = routeGroup(route);
            const found = byKey.get(key) ?? { missing: [], drifted: [], extra: [] };
            found[kind].push(route);
            byKey.set(key, found);
        }
    };
    file(`missing`, lists.missing);
    file(`drifted`, lists.drifted);
    file(`extra`, lists.extra);

    return [...byKey.entries()]
        .map(([key, found]): DriftArea => {
            const kind: DriftKind = found.missing.length > 0 ? `missing` : found.drifted.length > 0 ? `drifted` : `extra`;
            return {
                key,
                ...nameOf(key, found.missing.length === 0 && found.drifted.length === 0),
                missing: found.missing.toSorted(),
                drifted: found.drifted.toSorted(),
                extra: found.extra.toSorted(),
                kind,
                count: found.missing.length + found.drifted.length + found.extra.length,
            };
        })
        // Worst kind first, then the areas most of which is affected; the label only breaks ties, so the order is
        // about consequence rather than alphabet.
        .toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.count - a.count || a.label.localeCompare(b.label));
};

export const driftedAreas = computed(() =>
    driftAreas({ missing: missingRoutes.value, drifted: driftedRoutes.value, extra: unknownDaemonRoutes.value }),
);

// What each kind COSTS, never what it is: the heading already says which disagreement this is, and a drawer that
// restates it spends the one place there was room to say what actually goes wrong.
const KIND_IMPACT: Readonly<Record<DriftKind, () => string>> = {
    missing: () => t(`sandbox.driftReport.impact.missing`),
    drifted: () => t(`sandbox.driftReport.impact.drifted`),
    extra: () => t(`sandbox.driftReport.impact.extra`),
};
export const kindImpact = (kind: DriftKind): string => KIND_IMPACT[kind]();

// What the badge says, so the list can be read down its right edge without opening anything. Each stands for one of
// the sentences above. Never a number: the number is how many internal endpoints are involved, which is a fact about
// the code and not about the reader's day.
const KIND_TAG: Readonly<Record<DriftKind, () => string>> = {
    missing: () => t(`sandbox.driftReport.tag.missing`),
    drifted: () => t(`sandbox.driftReport.tag.drifted`),
    extra: () => t(`sandbox.driftReport.tag.extra`),
};
export const kindTag = (kind: DriftKind): string => KIND_TAG[kind]();

// `extra` is the one kind that costs nothing, so it is drawn as a remark rather than a warning; the other two are
// both a feature not working, loudly or silently.
export const KIND_TONE: Readonly<Record<DriftKind, "warning" | "info">> = { missing: `warning`, drifted: `warning`, extra: `info` };
export const KIND_BADGE: Readonly<Record<DriftKind, "warning" | "neutral">> = { missing: `warning`, drifted: `warning`, extra: `neutral` };

// A gap and a disagreement are not the same shape of failure, and the glyph says which before the words do:
// `arrows-h` for two sides pulling one thing apart, a warning triangle for something that isn't there at all.
export const KIND_ICON: Readonly<Record<DriftKind, "exclamation-triangle" | "arrows-h" | "question-circle">> = {
    missing: `exclamation-triangle`,
    drifted: `arrows-h`,
    extra: `question-circle`,
};

// THE TWO SIDES, named the way a reader would point at them: one is the thing they are looking at, the other is the
// thing behind it. This pair is the answer to "which of these two can't talk to the other", which is the question the
// old card left entirely unanswered.
export interface DriftParty {
    readonly icon: "window-maximize" | "box";
    readonly label: string;
    readonly what: string;
    // `older` on the side that is behind, when anything proves which one is; never on both, and absent whenever the
    // evidence only shows a disagreement. A guess about which side is stale sends someone to restart the wrong one.
    readonly age: "older" | "newer" | undefined;
}

// Which side is behind, from the only two facts that prove it: a part one side has and the other has never heard of.
// Both directions at once is a fork, where neither is simply older, so neither row is marked.
const ages = (): { app: DriftParty["age"]; sandbox: DriftParty["age"] } => {
    if (daemonBehind.value && appBehind.value) {
        return { app: undefined, sandbox: undefined };
    }
    if (daemonBehind.value) {
        return { app: `newer`, sandbox: `older` };
    }
    return appBehind.value ? { app: `older`, sandbox: `newer` } : { app: undefined, sandbox: undefined };
};

export const appParty = (): DriftParty => ({
    icon: `window-maximize`,
    label: t(`sandbox.driftReport.appLabel`),
    what: t(`sandbox.driftReport.appWhat`),
    age: ages().app,
});

export const sandboxParty = (where: string | undefined): DriftParty => ({
    icon: `box`,
    label: t(`sandbox.driftReport.sandboxLabel`),
    what: where === undefined ? t(`sandbox.driftReport.sandboxWhat`) : t(`sandbox.driftReport.sandboxWhatOn`, { where }),
    age: ages().sandbox,
});

