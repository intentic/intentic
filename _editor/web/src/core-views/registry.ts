import type { Activation, CapabilityFacts, Disposable, RepoFacts, ViewBadge, ViewRegistration } from "@intentic/extension-api";
import { shallowRef } from "vue";
import { coreViews } from "./coreViews";

/* The runtime extension registry: core views seed it at module load; dynamically loaded third-party bundles join
 * through api.views.register. A module-level singleton ref (the app's no-Pinia convention), so every host —
 * rail, mobile menu, ExtensionHost, DirectoryOperator — recomputes off the same reactive list. */

export interface RegisteredView {
    // "builtin" or the owning extension's id — error attribution and manifest-gating key off this.
    readonly owner: string;
    readonly registration: ViewRegistration;
}

const views = shallowRef<readonly RegisteredView[]>(coreViews.map((registration) => ({ owner: `builtin`, registration })));

/* EVERY LIVE REGISTRATION, whether or not it currently detects — the list the background loader reads to
 * collect what each view wants warmed (composables/prefetch/sources/extensionsWarm).
 *
 * Deliberately not filtered by detection. Detection needs the panels and the capability manifest, which are
 * themselves two of the things being warmed, so a warm list gated on them would be cold exactly when the app
 * has just connected and everything is cold — the moment it is worth the most. A registration only exists for
 * an extension the owner has installed and switched on, which is evidence enough to read one list ahead. */
export const registeredViews = (): readonly RegisteredView[] => views.value;

// A registration is IDENTIFIED by owner + view id, not by object identity: the same extension registering the
// same view id again can only mean it is being re-activated (the dev server hot-reloading the host module while
// this registry — a leaf dependency — keeps its instance, a re-run after install), never a second view. So a
// re-registration REPLACES its predecessor in place rather than appending; otherwise every re-activation grows
// the rail another copy of the same icon. In place, so tile order stays put while it happens.
export const registerView = (owner: string, registration: ViewRegistration): Disposable => {
    const entry: RegisteredView = { owner, registration };
    const index = views.value.findIndex((existing) => existing.owner === owner && existing.registration.id === registration.id);
    views.value = index === -1 ? [...views.value, entry] : views.value.with(index, entry);
    return {
        // Filtered by THIS entry, so a stale disposable held by a superseded activation can't evict the live
        // replacement — it just finds nothing to remove.
        dispose: (): void => {
            views.value = views.value.filter((existing) => existing !== entry);
        },
    };
};

// One resolved sidebar element: the view registration + the activation it contributed.
export interface ActiveExtension {
    readonly extension: ViewRegistration;
    readonly activation: Activation;
}

// The deep-link path to a sidebar element. The `:key` segment only disambiguates a view's multiple activations
// (one per repo: /ext/preview/<repo>); a singleton view names its sole activation after itself (key === id), so
// that segment would just repeat the view id — drop it. `/ext/documentation`, not `/ext/documentation/documentation`. ExtensionHost
// resolves the missing segment back to the view id.
export const extensionPath = (extension: ViewRegistration, activation: Activation): string =>
    activation.key === extension.id ? `/ext/${extension.id}` : `/ext/${extension.id}/${encodeURIComponent(activation.key)}`;

/* THE RAIL'S READING ORDER AND ITS GROUPS, owned by the app rather than by whoever registered first.
 *
 * Without this the rail was in registration order — core views, then the `builtins.ts` array — which is an
 * implementation detail, so Acceptance landed between Automations and Documentation for no reason a user could
 * infer. The rail is the app's own furniture and the order is a product decision, so it is declared here.
 *
 * ORDERED BY WHAT SUMMONS YOU, THEN BY HOW OFTEN YOU GO. The first table read as a narrowing from "the work" to
 * "the machinery underneath" — understand, verify, maintain, delegate, inspect, operate. That is a taxonomy of
 * nouns, and a rail is not read as a taxonomy: it is aimed at, from muscle memory, all day. Sorting by concept
 * put Documentation — a surface read once a month — in the best position left after the two pinned tiles, and
 * buried the ones that light up to fetch you. Position now tracks how a hand uses the column.
 *
 *   Work    Agents, Workspace — the two ends of one loop: start a turn, then read what it did and land it. Both
 *           are permanent and both are the busiest tiles in the product, so they take the two seats a hand finds
 *           without looking, and NOTHING is allowed between them. The first table put Drafts and Workflows there,
 *           which split the pair with two surfaces touched weekly.
 *   Judge   Drafts, Acceptance, Pipelines, Deployments, Maintenance — "does this go out, is it good, did it ship,
 *           what is owed". The tiles you click BECAUSE one lit up, so they are together and high. Drafts heads the
 *           band: it is the only one where nothing happens at all until the owner acts, and a post carrying a send
 *           time is the most perishable thing on the rail.
 *   Set up  Workflows, Automations — the two ways a run happens without anyone sitting there. The mechanisms have
 *           little in common (a workflow forks a prompt across sessions and merges what comes back; an automation
 *           is a trigger), but their relationship to the day is identical: authored once, then left alone, and
 *           neither ever lights up. That is what makes them a shelf rather than work — Workflows previously sat
 *           third, an unbadged permanent tile holding a seat the hand reaches for by reflex.
 *   Know    Documentation, Infrastructure, Live status — what you go and consult on your own initiative.
 *           Documentation badges, and its badge is well formed: generated docs waiting to be reviewed, which
 *           clears by looking. It fires rarely, which is the standard — rarely and meaningfully, not often.
 *
 * WHAT A SEAT COSTS, AND WHO STOPPED PAYING IT. Memory and Activity were in Know and are gone from the rail
 * entirely; they are sections of the sandbox hub now (their extension.ts files carry the argument). The rule they
 * failed is the one logs failed before them: a tile earns a permanent seat by being somewhere you go constantly
 * or by being able to tell you something happened, and neither of those two can ever badge — one is the agent's
 * notebook, the other a feed that is always moving. The cost was never abstract. The rail can reach fourteen
 * navigation tiles and roughly nine fit above a 945px viewport before the column scrolls (see the flex-shrink
 * note in ShellDesktop), so every silent permanent tile is a badged one pushed under the fold on a laptop.
 *
 * The bands are DECLARED, not derived. `badge: true` in the manifest lands on the Judge extensions and nothing
 * else, which is good evidence the band is real — but deriving from it would reshuffle the whole rail the day
 * Automations grows a badge, and a column whose order moves is a column that has to be re-read.
 *
 * IT NAMES CORE SHELL TILES TOO (`agents`, `drafts`, `workspace`), not just extensions. Order used to live half
 * here and half in ShellDesktop's fixedTiles, which is how an extension could not be placed among the core views
 * at all — only "after every core view". One column, one table. Drafts is what that buys: a core shell surface
 * banded with the four extensions it shares a job with, which no split table could have said.
 *
 * An id absent from these groups keeps its registration position within the last group, so a third-party
 * extension appends rather than silently jumping the queue. Note what that default cost the two first-party
 * views added after the first table shipped: `workflows` and `deployments` were never listed, so they sorted
 * BELOW Infrastructure and Live status — the newest surfaces in the worst seats, which is the very drift this
 * table exists to prevent. Add a rail view here in the same commit that registers it. */
export interface RailGroup {
    readonly id: string;
    // Used as the mobile menu's section heading; the desktop rail is 44px wide and separates with a hairline.
    readonly label: string;
    readonly ids: readonly string[];
}

export const RAIL_GROUPS: readonly RailGroup[] = [
    { id: `work`, label: `Work`, ids: [`chat`, `agents`, `workspace`] },
    { id: `judge`, label: `Judge`, ids: [`drafts`, `acceptance`, `pipelines`, `deployments`, `maintenance`] },
    { id: `setup`, label: `Set up`, ids: [`workflows`, `automations`] },
    { id: `know`, label: `Know`, ids: [`documentation`, `infrastructure`, `live-status`] },
];

const RAIL_ORDER: readonly string[] = RAIL_GROUPS.flatMap((group) => group.ids);

/* WHAT THE MOBILE TAB BAR HAS ALREADY PROMOTED, and therefore what the mobile menu must not list again.
 *
 * A phone has four thumb tabs and the rail's whole column behind the fourth of them, so a surface can be
 * reachable twice — and two of these were: Drafts was the Review tab AND a "Drafts" row in the Judge band,
 * same badge, same count, two names. Workspace is the Files tab; Chat is the agent route.
 *
 * VIEW IDS, the same key RAIL_GROUPS ranks and `detectActivations` returns — not the publisher-and-name
 * package ids the sandbox's extension routes speak. The tab bar previously matched drafts on the package id
 * and so never matched at all. Declared once here because two surfaces read it: the bar, to find the tile it
 * promotes, and the menu, to drop it. A list in each of them is how they came to disagree. */
export const DRAFTS_VIEW_ID = `drafts`;
export const TAB_BAR_IDS: readonly string[] = [DRAFTS_VIEW_ID, `workspace`, `chat`, `agents`];

export const railRank = (id: string): number => {
    const at = RAIL_ORDER.indexOf(id);
    return at === -1 ? RAIL_ORDER.length : at;
};

// Which band a rail element renders in. An unlisted id lands in the last group, matching where railRank puts it —
// the two must agree, or a tile would sort into one run and be drawn under another's divider.
const railGroupOf = (id: string): RailGroup => RAIL_GROUPS.find((group) => group.ids.includes(id)) ?? RAIL_GROUPS[RAIL_GROUPS.length - 1]!;

/* Cut a rail-ordered run into its bands, dropping the ones nothing landed in — so a surface never draws a
 * separator (or a heading) over nothing on a workspace where a whole band has not activated. Shared by the
 * desktop rail and the mobile menu for the same reason detectActivations sorts here rather than in each of them:
 * a band that existed in one surface and not the other is the same fact told two ways. */
export const railBands = <T>(items: readonly T[], idOf: (item: T) => string): { readonly group: RailGroup; readonly items: readonly T[] }[] =>
    RAIL_GROUPS.map((group) => ({ group, items: items.filter((item) => railGroupOf(idOf(item)) === group) })).filter((band) => band.items.length > 0);

// detect() failures are contained, not propagated: one broken extension contributes nothing this round instead
// of blanking every sidebar element with it.
const safeDetect = (entry: RegisteredView, repos: readonly RepoFacts[], capabilities: readonly CapabilityFacts[]): Activation[] => {
    try {
        return entry.registration.detect(repos, capabilities);
    } catch (error) {
        console.error(`extension ${entry.owner}/${entry.registration.id}: detect() failed`, error);
        return [];
    }
};

// Run every registered view's detect() and compose the sidebar: fallback activations are dropped for repos a
// claiming view already serves — the single cross-extension rule, applied once here. Neither a `fallback` view
// nor an `auxiliary` one claims: the first because it IS the thing being replaced, the second because it sits
// beside the repo's main surface rather than subsuming it (see ViewRegistration.auxiliary). Repo-less
// (capability-driven) activations sit outside the claim rule. Reads the registry ref, so callers inside a
// computed re-run when an extension registers or disposes.
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
    /* Ordered here rather than in the surfaces, because BOTH the desktop rail and the mobile menu render this
     * list and they must not disagree about what comes after what — ordering in each of them is the same fact in
     * two places, which is the drift this file already avoids for registration.
     *
     * A stable sort, and only rail ids are ranked: everything unlisted shares the last rank and therefore keeps
     * its registration order. So per-repo directory panels — which are ordered by the repo they belong to, not by
     * any table here — pass through untouched. */
    return resolved.toSorted((left, right) => railRank(left.extension.id) - railRank(right.extension.id));
};

// An element's tile badge, contained the same way detect() is: a throwing badge costs its own tile a number,
// never the whole rail. Called from the surfaces' render computeds, so the extension reading its own refs in
// here is what makes the tile repaint. A badge with neither a count above zero nor a mark has nothing to draw
// and normalizes to undefined, so callers only ever test for presence.
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
