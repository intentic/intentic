import type { Activation, CapabilityFacts, Disposable, RepoFacts, ViewBadge, ViewRegistration } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { type Audience, useAudience } from "../app/useAudience";
import { coreViews } from "./coreViews";
import { badgeSpeaks } from "./viewBadge";

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
    // For an `always` seat an extension's view fills: the core id that takes the seat while that view is not
    // registered, so switching the extension off leaves a home rather than a hole.
    readonly standIn?: string;
}

export interface RailGroup {
    readonly id: string;
    // Used as the mobile menu's section heading; the desktop rail is 44px wide and separates with a hairline.
    readonly label: string;
    readonly items: readonly RailItem[];
}

const always = (id: string, standIn?: string): RailItem => (standIn === undefined ? { id, seat: `always` } : { id, seat: `always`, standIn });
const signal = (id: string): RailItem => ({ id, seat: `signal` });

// The maker's home is the Projects dashboard (`@intentic/ext-projects`), seated where a developer has the file tree.
export const PROJECTS_VIEW_ID = `projects`;
export const WORKSPACE_VIEW_ID = `workspace`;

// Every tile here badges when it needs the owner, and lights while a run of its own is in flight; being
// seated by lighting up costs them nothing.
const JUDGE: RailGroup = {
    id: `judge`,
    label: `Judge`,
    items: [signal(`approvals`), signal(`acceptance`), signal(`pipelines`), signal(`deployments`), signal(`maintenance`)],
};
// Authored once, then left alone. Automations never badges: a held wake is counted by Approvals instead.
const SETUP: RailGroup = { id: `setup`, label: `Set up`, items: [signal(`workflows`), signal(`automations`)] };
// Consulted deliberately, not summoned; Documentation badges rarely and meaningfully, the others don't at all.
const KNOW: RailGroup = { id: `know`, label: `Know`, items: [signal(`documentation`), signal(`infrastructure`), signal(`live-status`)] };

// One table per audience; only the Work band differs. Preview is `always` for being visited constantly, not for its
// badge, which counts an inventory, not a claim.
// The Projects tile is seated for everyone: it is where the project scope (app/projectScope.ts) is read and changed,
// and a scope with no seat would be a mode with no indicator. For a developer it sits beside the file tree; for a
// maker it takes the tree's seat and the tree stands in for it.
const RAIL_GROUPS_BY_AUDIENCE: Record<Audience, readonly RailGroup[]> = {
    developer: [
        {
            id: `work`,
            label: `Work`,
            items: [always(`chat`), always(`agents`), always(PROJECTS_VIEW_ID), always(WORKSPACE_VIEW_ID), always(`preview`)],
        },
        JUDGE,
        SETUP,
        KNOW,
    ],
    // The file tree keeps its rank beside the home it stands in for, so a maker who opens it finds it in the same seat.
    maker: [
        {
            id: `work`,
            label: `Work`,
            items: [always(`chat`), always(`agents`), always(PROJECTS_VIEW_ID, WORKSPACE_VIEW_ID), signal(WORKSPACE_VIEW_ID), always(`preview`)],
        },
        JUDGE,
        SETUP,
        KNOW,
    ],
};

export const railGroupsFor = (audience: Audience): readonly RailGroup[] => RAIL_GROUPS_BY_AUDIENCE[audience];

// The developer's table, which is also what every surface read before there were two.
export const RAIL_GROUPS: readonly RailGroup[] = RAIL_GROUPS_BY_AUDIENCE.developer;

// The table for whoever is looking; reactive when read inside a computed, like everything below that reads it.
const activeGroups = (): readonly RailGroup[] => railGroupsFor(useAudience().audience.value);

const isRegistered = (id: string): boolean => views.value.some((entry) => entry.registration.id === id);

// An unlisted id is `signal`, matching railRank's default: it appends and earns its place by badging. A stand-in
// inherits the `always` seat of the view it fills in for while that view is not registered.
export const seatPolicy = (id: string): SeatPolicy => {
    const items = activeGroups().flatMap((group) => group.items);
    const own = items.find((item) => item.id === id)?.seat ?? `signal`;
    if (own === `always`) {
        return own;
    }
    const filling = items.find((item) => item.standIn === id && item.seat === `always`);
    return filling !== undefined && !isRegistered(filling.id) ? `always` : own;
};

// The view a tile press on the home seat opens: the Project view when a maker has it, else the file tree.
export const homeViewId = (): string => (useAudience().maker.value && isRegistered(PROJECTS_VIEW_ID) ? PROJECTS_VIEW_ID : WORKSPACE_VIEW_ID);

// Whether a tile is on the rail now, in one predicate: the rail and the More menu ask its positive and
// negative of the same list. `pinned` overrules the table; `active` keeps the current area seated while you're in it.
// A badge seats a tile whatever it says, an errand or only that something is running there. The rail has always
// seated live work (an open browser, a subagent, a workflow run), so a running pipeline earning no seat would be
// arbitrary — and a tile that stays away until the run fails hides the half hour when watching it is the point.
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
export const tabBarIds = (): readonly string[] => [APPROVALS_VIEW_ID, homeViewId(), `chat`, `agents`];

const railOrder = (): readonly string[] => activeGroups().flatMap((group) => group.items.map((item) => item.id));

export const railRank = (id: string): number => {
    const order = railOrder();
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
};

// An unlisted id lands in the last group, matching railRank, so it can't sort under the wrong divider.
const railGroupOf = (id: string): RailGroup => {
    const groups = activeGroups();
    return groups.find((group) => group.items.some((item) => item.id === id)) ?? groups.at(-1)!;
};

// Cuts a rail-ordered run into its bands, dropping empty ones so nothing draws a separator over an
// unactivated band. Shared by the desktop rail and mobile menu so they can't disagree.
export const railBands = <T>(items: readonly T[], idOf: (item: T) => string): { readonly group: RailGroup; readonly items: readonly T[] }[] =>
    activeGroups()
        .map((group) => ({ group, items: items.filter((item) => railGroupOf(idOf(item)) === group) }))
        .filter((band) => band.items.length > 0);

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
// Normalizes to undefined when there's nothing to draw, so callers only test for presence. `badgeSpeaks`
// counts a running mark as something to draw: a view whose only news is "this is happening now" keeps its
// badge, and with it its seat.
export const activationBadge = ({ extension, activation }: ActiveExtension): ViewBadge | undefined => {
    if (extension.badge === undefined) {
        return undefined;
    }
    try {
        const badge = extension.badge(activation);
        return badge === undefined || !badgeSpeaks(badge) ? undefined : badge;
    } catch (error) {
        console.error(`extension view ${extension.id}: badge() failed`, error);
        return undefined;
    }
};
