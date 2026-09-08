import type { Activation, CapabilityFacts, Disposable, RepoFacts, ViewBadge, ViewRegistration } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { coreViews } from "./coreViews";

// Runtime extension registry: core views seed it at load, third-party bundles join via api.views.register.
// Module-level singleton ref, so every host (rail, mobile menu, ExtensionHost, DirectoryOperator) recomputes
// off the same list.

export interface RegisteredView {
    // "builtin" or the owning extension's id; error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly registration: ViewRegistration;
}

const views = shallowRef<readonly RegisteredView[]>(coreViews.map((registration) => ({ owner: `builtin`, registration })));

// Every live registration regardless of detection, read by the background loader to warm what each view
// wants. Not filtered by detection: that needs panels/capabilities, which are themselves being warmed.
export const registeredViews = (): readonly RegisteredView[] => views.value;

// A registration is identified by owner + view id, not object identity: re-registering the same id replaces
// it in place (a hot-reloaded or re-activated extension), so the rail never grows a duplicate icon.
export const registerView = (owner: string, registration: ViewRegistration): Disposable => {
    const entry: RegisteredView = { owner, registration };
    const index = views.value.findIndex((existing) => existing.owner === owner && existing.registration.id === registration.id);
    views.value = index === -1 ? [...views.value, entry] : views.value.with(index, entry);
    return {
        // Filtered by this entry, so a stale disposable from a superseded activation finds nothing to remove.
        dispose: (): void => {
            views.value = views.value.filter((existing) => existing !== entry);
        },
    };
};

// One resolved sidebar element: the view registration plus the activation it contributed.
export interface ActiveExtension {
    readonly extension: ViewRegistration;
    readonly activation: Activation;
}

// Deep-link path to a sidebar element. `:key` is dropped when it only repeats the view id (a singleton
// view); ExtensionHost resolves the missing segment back.
export const extensionPath = (extension: ViewRegistration, activation: Activation): string =>
    activation.key === extension.id ? `/ext/${extension.id}` : `/ext/${extension.id}/${encodeURIComponent(activation.key)}`;

// Rail order and which tiles show, declared here so the desktop rail and mobile menu agree. `always` seats
// are constant destinations (chat, agents, workspace, preview); everything else is `signal`, seated only
// while it badges. Bands are declared, not derived, covering core shell tiles alongside extensions in one table.
// Whether a tile holds its seat unconditionally or only while it has something to say (see railSeated).
export type SeatPolicy = "always" | "signal";

export interface RailItem {
    readonly id: string;
    readonly seat: SeatPolicy;
}

export interface RailGroup {
    readonly id: string;
    // Used as the mobile menu's section heading; the desktop rail is 44px wide and separates with a hairline.
    readonly label: string;
    readonly items: readonly RailItem[];
}

const always = (id: string): RailItem => ({ id, seat: `always` });
const signal = (id: string): RailItem => ({ id, seat: `signal` });

export const RAIL_GROUPS: readonly RailGroup[] = [
    // Preview is `always` for being visited constantly, not for its badge, which counts an inventory, not a claim.
    { id: `work`, label: `Work`, items: [always(`chat`), always(`agents`), always(`workspace`), always(`preview`)] },
    // Every tile here badges when it needs the owner; being seated by lighting up costs them nothing.
    {
        id: `judge`,
        label: `Judge`,
        items: [signal(`approvals`), signal(`acceptance`), signal(`pipelines`), signal(`deployments`), signal(`maintenance`)],
    },
    // Authored once, then left alone. Automations never badges: a held wake is counted by Approvals instead.
    { id: `setup`, label: `Set up`, items: [signal(`workflows`), signal(`automations`)] },
    // Consulted deliberately, not summoned; Documentation badges rarely and meaningfully, the others don't at all.
    { id: `know`, label: `Know`, items: [signal(`documentation`), signal(`infrastructure`), signal(`live-status`)] },
];

const RAIL_ORDER: readonly string[] = RAIL_GROUPS.flatMap((group) => group.items.map((item) => item.id));

const SEAT_POLICY: ReadonlyMap<string, SeatPolicy> = new Map(
    RAIL_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.seat] as const)),
);

// An unlisted id is `signal`, matching railRank's default: it appends and earns its place by badging.
export const seatPolicy = (id: string): SeatPolicy => SEAT_POLICY.get(id) ?? `signal`;

// Whether a tile is on the rail now, in one predicate: the rail and the More menu ask its positive and
// negative of the same list. `pinned` overrules the table; `active` keeps the current area seated while you're in it.
export const railSeated = (
    tile: { readonly id: string; readonly badge?: ViewBadge | undefined },
    context: { readonly pinned: boolean; readonly active: boolean },
): boolean => seatPolicy(tile.id) === `always` || context.pinned || context.active || tile.badge !== undefined;

// Seated only because you're standing on it (the `active` clause alone): the one tile gone the moment you
// leave. A label predicate for that case, not a seat one; derived from railSeated so the two can't drift.
export const seatedOnlyByVisit = (
    tile: { readonly id: string; readonly badge?: ViewBadge | undefined },
    context: { readonly pinned: boolean; readonly active: boolean },
): boolean => context.active && !railSeated(tile, { pinned: context.pinned, active: false });

// What the mobile tab bar already promotes, so the mobile menu doesn't list it again. View ids, the same
// key RAIL_GROUPS and detectActivations use, not package ids.
export const APPROVALS_VIEW_ID = `approvals`;
export const TAB_BAR_IDS: readonly string[] = [APPROVALS_VIEW_ID, `workspace`, `chat`, `agents`];

export const railRank = (id: string): number => {
    const at = RAIL_ORDER.indexOf(id);
    return at === -1 ? RAIL_ORDER.length : at;
};

// An unlisted id lands in the last group, matching railRank, so it can't sort under the wrong divider.
const railGroupOf = (id: string): RailGroup => RAIL_GROUPS.find((group) => group.items.some((item) => item.id === id)) ?? RAIL_GROUPS.at(-1)!;

// Cuts a rail-ordered run into its bands, dropping empty ones so nothing draws a separator over an
// unactivated band. Shared by the desktop rail and mobile menu so they can't disagree.
export const railBands = <T>(items: readonly T[], idOf: (item: T) => string): { readonly group: RailGroup; readonly items: readonly T[] }[] =>
    RAIL_GROUPS.map((group) => ({ group, items: items.filter((item) => railGroupOf(idOf(item)) === group) })).filter((band) => band.items.length > 0);

// detect() failures are contained: one broken extension contributes nothing this round, not a blanked sidebar.
const safeDetect = (entry: RegisteredView, repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]): Activation[] => {
    try {
        return entry.registration.detect(repos, capabilities);
    } catch (error) {
        console.error(`extension ${entry.owner}/${entry.registration.id}: detect() failed`, error);
        return [];
    }
};

// Runs every detect() and composes the sidebar; fallback activations drop for repos a claiming view already
// serves. Neither `fallback` nor `auxiliary` claims; repo-less activations sit outside the rule.
export const detectActivations = (repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]): ActiveExtension[] => {
    const detected = views.value.map((entry) => ({ extension: entry.registration, activations: safeDetect(entry, repos, capabilities) }));
    const claimed = new Set(
        detected
            .filter(({ extension }) => extension.fallback !== true && extension.auxiliary !== true)
            .flatMap(({ activations }) => activations.flatMap((a) => (a.repo === undefined ? [] : [a.repo]))),
    );
    const resolved = detected.flatMap(({ extension, activations }) =>
        (extension.fallback === true ? activations.filter((a) => a.repo === undefined || !claimed.has(a.repo)) : activations).map((activation) => ({
            extension,
            activation,
        })),
    );
    // Ordered here, not per-surface, so the rail and menu can't disagree; unlisted ids share the last rank.
    return resolved.toSorted((left, right) => railRank(left.extension.id) - railRank(right.extension.id));
};

// An element's badge, contained like detect(): a throwing badge costs its own tile, not the whole rail.
// Normalizes to undefined when there's nothing to draw, so callers only test for presence.
export const activationBadge = ({ extension, activation }: ActiveExtension): ViewBadge | undefined => {
    if (extension.badge === undefined) {
        return undefined;
    }
    try {
        const badge = extension.badge(activation);
        return badge === undefined || ((badge.count ?? 0) <= 0 && badge.mark === undefined) ? undefined : badge;
    } catch (error) {
        console.error(`extension view ${extension.id}: badge() failed`, error);
        return undefined;
    }
};
