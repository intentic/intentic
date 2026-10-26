import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { driftedRoutes, missingRoutes, unknownDaemonRoutes } from "../../../../client/sandbox/useDaemonRoutes";
import { namedArea, routeGroup } from "../../../../client/sandbox/daemon/routeAreas";

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
    // Where in the app the reader would be standing when this bites, one short line in the chip's popover. Absent for
    // an area of ours the table has no plain name for: "a part this page has no plain name for" said nothing.
    readonly where: string | undefined;
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
// grouped by their path, bring more of. That one goes by its name alone.
const nameOf = (key: string, theirsOnly: boolean): { label: string; where: string | undefined } =>
    namedArea(key) ?? {
        label: key.charAt(0).toUpperCase() + key.slice(1),
        where: theirsOnly ? t(`sandbox.driftReport.unknownWhere`) : undefined,
    };

// Folds three flat route lists into one row per area of the product. Pure, so the whole table above is testable
// without a daemon.
export const driftAreas = (lists: { missing: readonly string[]; drifted: readonly string[]; extra: readonly string[] }): readonly DriftArea[] => {
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

    return (
        [...byKey.entries()]
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
            .toSorted((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.count - a.count || a.label.localeCompare(b.label))
    );
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

// What each group of chips is called, read down the card's left edge. Never a number: the number is how many internal
// endpoints are involved, which is a fact about the code and not about the reader's day.
const KIND_TAG: Readonly<Record<DriftKind, () => string>> = {
    missing: () => t(`sandbox.driftReport.tag.missing`),
    drifted: () => t(`sandbox.driftReport.tag.drifted`),
    extra: () => t(`sandbox.driftReport.tag.extra`),
};
export const kindTag = (kind: DriftKind): string => KIND_TAG[kind]();

// A part that is gone reads red, one that may lie reads amber, and `extra`, the one kind that costs nothing, stays neutral.
export const KIND_TONE: Readonly<Record<DriftKind, "danger" | "warning" | "neutral">> = { missing: `danger`, drifted: `warning`, extra: `neutral` };

export interface DriftGroup {
    readonly kind: DriftKind;
    readonly areas: readonly DriftArea[];
}

// ONE LINE PER KIND, NOT ONE ROW PER AREA. Fifteen rows each repeating "may misbehave" was a wall; the kind is said
// once, as the line's label, and the areas are chips after it. An area sits under the worst kind it holds, and its
// popover names every kind it holds. Kinds with nothing in them are left out.
export const driftGroups = (areas: readonly DriftArea[]): readonly DriftGroup[] =>
    ([`missing`, `drifted`, `extra`] as const)
        .map((kind) => ({ kind, areas: areas.filter((area) => area.kind === kind) }))
        .filter((group) => group.areas.length > 0);
