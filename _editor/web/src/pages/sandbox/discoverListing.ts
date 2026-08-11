import { extensionIdOf } from "@intentic/extension-manifest";
import { isShaPinned, type RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";

/* WHAT A REGISTRY ROW BECOMES ONCE THIS SANDBOX IS TAKEN INTO ACCOUNT.
 *
 * The registry knows what has been published; the daemon knows what is installed here. Neither alone can answer
 * the only question a person browsing has — "is this one for me to get, or one I already have?" — and the join
 * is what turns a catalogue into a surface you can act on. Kept as a pure module because it is the part with
 * cases in it: five states, two of which look identical on screen until you read why the button is off.
 *
 * THE JOIN KEY IS THE MANIFEST IDENTITY, not the capability id. A git-installed extension is named by whoever
 * installed it (its capability entry is called whatever they typed in the box), while the listing is keyed by
 * `publisher.name` read out of the manifest — the identity the app installs under and the one thing a registry
 * cannot rename or spoof. Matching on the typed name would show "Install" over an extension the reader already
 * has under a name of their own choosing. */

export type ListingStateKind = "installable" | "installed" | "update" | "blocked" | "unavailable";

export interface ListingState {
    readonly kind: ListingStateKind;
    /** The button's word. Absent when there is no button to press. */
    readonly action?: string;
    /** Why it cannot be installed, in the reader's words — a disabled control with no reason reads as a bug. */
    readonly reason?: string;
    /** The commit that is installed here, when one is and it differs from the listed one. */
    readonly installedRef?: string;
}

export interface DiscoverListing {
    readonly entry: RegistryEntry;
    readonly state: ListingState;
    /** Everything the filter box may match on, pre-lowercased — the same trick the Extensions tab's rows use. */
    readonly search: string;
}

/* WHAT THE NIGHTLY SCAN FOUND AT THIS ROW'S PINNED COMMIT, folded to the one question somebody browsing has:
 * will it load? Absent checks say NOTHING and must render as nothing — a registry that runs no scanner, or a
 * listing repointed since last night, is not evidence of a problem, and a warning there would punish every
 * private registry for not running a bot. "none" is a daemon-only extension with no browser bundle, which
 * loads perfectly well. Shared with the card, the detail panel and the Capabilities page so the app cannot
 * end up with two readings of one field. */
export const checksProblem = (entry: RegistryEntry): string | undefined => {
    if (entry.checks === undefined) {
        return undefined;
    }
    if (entry.checks.manifest !== `ok`) {
        return `At the pinned commit, ${entry.checks.manifest}`;
    }
    return entry.checks.bundle === `ok` || entry.checks.bundle === `none` ? undefined : `At the pinned commit, the bundle ${entry.checks.bundle}`;
};

export const checksOk = (entry: RegistryEntry): boolean => entry.checks !== undefined && checksProblem(entry) === undefined;

/* THE STATE, in the order the cases actually override each other.
 *
 * Blocked leads, and it leads even over "you already have this": it is the one case where the row is fine
 * mechanically and the answer is still no, and somebody who installed it before it was blocked is precisely
 * the reader who most needs to be told. The pointer rules come next because they are about whether an install
 * is possible at all, and only then does what is installed here get a say. */
export const listingState = (entry: RegistryEntry, installed: readonly ExtensionSummary[]): ListingState => {
    if (entry.trust === `blocked`) {
        return { kind: `blocked`, reason: entry.trustReason ?? `Blocked by the registry.` };
    }
    const here = installed.find((extension) => extensionIdOf(extension.manifest) === entry.name);
    if (entry.install === undefined) {
        return { kind: `unavailable`, reason: `Published somewhere this sandbox can't clone from.` };
    }
    if (!isShaPinned(entry.install)) {
        // Not a defect in the listing — it reads fine and links out fine. It just cannot be a one-click
        // install, because extension code runs trusted in this browser and a branch is not a promise.
        return { kind: `unavailable`, reason: `The listing names no exact commit, so it can't be installed in one click.` };
    }
    if (!entry.admitted) {
        return {
            kind: `unavailable`,
            reason: `This exact commit has not passed the official registry's current security audit, so it cannot be installed from discovery.`,
        };
    }
    if (here === undefined) {
        return { kind: `installable`, action: `Install` };
    }
    /* An image-baked or workspace extension sharing this identity is INSTALLED and is not updatable from here:
     * one ships with the sandbox image and the other is a directory somebody is editing, and offering to
     * replace either with a registry commit would be offering to delete their work. */
    if (here.source !== `installed` || here.commit === entry.install.ref) {
        return { kind: `installed` };
    }
    return { kind: `update`, action: `Update`, installedRef: here.commit };
};

// Pre-lowercased, and deliberately wider than what the card draws: somebody looking for "invoices" should find
// the extension whose description says so, and somebody looking for a publisher should find everything of
// theirs. The category rides along because it is a word people search with even where nothing displays it.
const searchTextOf = (entry: RegistryEntry): string =>
    [entry.name, entry.description, entry.category, entry.version]
        .filter((part) => part !== undefined && part !== ``)
        .join(` `)
        .toLowerCase();

export const toListing = (entry: RegistryEntry, installed: readonly ExtensionSummary[]): DiscoverListing => ({
    entry,
    state: listingState(entry, installed),
    search: searchTextOf(entry),
});

/** The publisher half of `publisher.name`, and the extension's own half — drawn on two lines on a card. */
export const splitListingName = (name: string): { readonly publisher: string; readonly title: string } => {
    const dot = name.indexOf(`.`);
    // A listing whose name carries no dot is not one this app installs, but it still has to draw as something.
    return dot === -1 ? { publisher: ``, title: name } : { publisher: name.slice(0, dot), title: name.slice(dot + 1) };
};

export interface ListingSection {
    readonly id: string;
    readonly label: string;
    readonly caption: string;
    readonly listings: readonly DiscoverListing[];
}

/* THE TWO GROUPS, and why they are the website's two groups exactly.
 *
 * Verified means a human read the source at the listed commit — the most expensive thing anybody does per
 * listing, and until now a single glyph in a scrolling box. Leading with it is the whole point of the surface.
 * The second group keeps its honest caption rather than being dressed up as a review, because the difference
 * between "somebody read this" and "nobody has" is the only claim this page is really making.
 *
 * The public gallery splits the same rows the same way with the same words. That is not a coincidence to be
 * tidied up later: a person who browsed the gallery and then opened the app should see one catalogue, not two
 * presentations of one. */
export const listingSections = (listings: readonly DiscoverListing[]): readonly ListingSection[] =>
    [
        {
            id: `verified`,
            label: `Verified`,
            caption: `the deterministic scan and agent audit passed, and someone read the source at the listed commit`,
            listings: listings.filter((listing) => listing.entry.trust === `verified`),
        },
        {
            id: `listed`,
            label: `Everything published`,
            caption: `no human source review — open an entry to see both automated checks`,
            listings: listings.filter((listing) => listing.entry.trust !== `verified`),
        },
    ].filter((section) => section.listings.length > 0);

/** How many installed extensions this registry has a newer reviewed commit for — the hub row's badge. */
export const updateCount = (listings: readonly DiscoverListing[]): number => listings.filter((listing) => listing.state.kind === `update`).length;
