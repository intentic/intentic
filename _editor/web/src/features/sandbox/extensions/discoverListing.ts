import { extensionIdOf } from "@intentic/extension-manifest";
import { isShaPinned, type RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";

// What a registry row becomes once this sandbox is checked against it: installable, installed, an update, blocked,
// or unavailable. Joined on the manifest identity (`publisher.name`), not the capability id, since that can be
// renamed while the identity can't.

export type ListingStateKind = "installable" | "installed" | "update" | "blocked" | "unavailable";

export interface ListingState {
    readonly kind: ListingStateKind;
    /** The button's word; absent when there is no button to press. */
    readonly action?: string;
    /** Why it can't be installed, in the reader's words; a disabled control with no reason reads as a bug. */
    readonly reason?: string;
    /** The commit that is installed here, when one is and it differs from the listed one. */
    readonly installedRef?: string;
}

export interface DiscoverListing {
    readonly entry: RegistryEntry;
    readonly state: ListingState;
    /** Everything the filter box may match on, pre-lowercased. */
    readonly search: string;
}

// Whether the nightly scan found a problem at this row's pinned commit; absent means no scan ran, not a clean bill.
// `bundle: "none"` is a daemon-only extension with no browser bundle, which loads fine.
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

// Blocked wins even over already-installed, since a reader who installed before a block needs to know most.
// Pointer validity is checked next, and only then does what's installed here decide the rest.
export const listingState = (entry: RegistryEntry, installed: readonly ExtensionSummary[]): ListingState => {
    if (entry.trust === `blocked`) {
        return { kind: `blocked`, reason: entry.trustReason ?? `Blocked by the registry.` };
    }
    const here = installed.find((extension) => extensionIdOf(extension.manifest) === entry.name);
    if (entry.install === undefined) {
        return { kind: `unavailable`, reason: `Published somewhere this sandbox can't clone from.` };
    }
    if (!isShaPinned(entry.install)) {
        // Reads and links fine; not a one-click install, since code runs trusted here and a branch isn't a promise.
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
    // Built-in or workspace extensions here read as installed, never updatable: replacing either deletes work.
    if (here.source !== `installed` || here.commit === entry.install.ref) {
        return { kind: `installed` };
    }
    return { kind: `update`, action: `Update`, installedRef: here.commit };
};

// Pre-lowercased and wider than the card shows: matches on description and publisher too, not just name.
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

/** The publisher half of `publisher.name`, and the extension's own half, drawn on two lines on a card. */
export const splitListingName = (name: string): { readonly publisher: string; readonly title: string } => {
    const dot = name.indexOf(`.`);
    // A name with no dot isn't one this app would install, but it still has to draw as something.
    return dot === -1 ? { publisher: ``, title: name } : { publisher: name.slice(0, dot), title: name.slice(dot + 1) };
};

export interface ListingSection {
    readonly id: string;
    readonly label: string;
    readonly caption: string;
    readonly listings: readonly DiscoverListing[];
}

// Verified means a human read the source at the listed commit; leading with it is the point of the surface.
// The other group keeps an honest caption instead of dressing up as reviewed.
export const listingSections = (listings: readonly DiscoverListing[]): readonly ListingSection[] =>
    [
        {
            id: `verified`,
            label: `Verified`,
            caption: ``,
            listings: listings.filter((listing) => listing.entry.trust === `verified`),
        },
        {
            id: `listed`,
            label: `Everything published`,
            caption: ``,
            listings: listings.filter((listing) => listing.entry.trust !== `verified`),
        },
    ].filter((section) => section.listings.length > 0);

/** How many installed extensions this registry has a newer reviewed commit for, the hub row's badge. */
export const updateCount = (listings: readonly DiscoverListing[]): number => listings.filter((listing) => listing.state.kind === `update`).length;
