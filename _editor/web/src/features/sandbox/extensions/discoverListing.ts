import { extensionIdOf } from "@intentic/extension-manifest";
import { isShaPinned, type RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// What a registry row becomes once this sandbox is checked against it: installable, installed, an update, blocked,
// or unavailable. Joined on the manifest identity (`publisher.name`), not the capability id, since that can be
// renamed while the identity can't. A commit the registry hasn't admitted stays installable, flagged `unaudited`.

export type ListingStateKind = "installable" | "installed" | "update" | "blocked" | "unavailable";

export interface ListingState {
    readonly kind: ListingStateKind;
    /** The button's word; absent when there is no button to press. */
    readonly action?: string;
    /** Why it can't be installed, in the reader's words; a disabled control with no reason reads as a bug. */
    readonly reason?: string;
    /** The commit that is installed here, when one is and it differs from the listed one. */
    readonly installedRef?: string;
    /**
     * The capability id it is installed under, which an update must target: hand-installed ones are often named
     * otherwise than the id a listing derives, and an add under the derived one installs a duplicate beside it.
     */
    readonly installedId?: string;
    /** The listed commit hasn't passed the registry's current security audit; acting on it needs an explicit yes. */
    readonly unaudited?: true;
}

/** What an install or update from a listing came to, once the host has reconciled: the dialog's receipt. */
export interface InstallOutcome {
    readonly verb: `install` | `update`;
    /** The id it is installed under here, when the refreshed list has it. */
    readonly id: string | undefined;
    /** Why it did not start in this browser, in the host's words; undefined when it did. */
    readonly problem: string | undefined;
    /** Its switch is off: an update keeps the owner's off. */
    readonly off: boolean;
    /** It declares settings, which its Installed row is where to fill in. */
    readonly settings: boolean;
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
        return t(`sandbox.discoverListing.atPinnedCommit`, { problem: entry.checks.manifest });
    }
    return entry.checks.bundle === `ok` || entry.checks.bundle === `none`
        ? undefined
        : t(`sandbox.discoverListing.bundleAtPinnedCommit`, { problem: entry.checks.bundle });
};

export const checksOk = (entry: RegistryEntry): boolean => entry.checks !== undefined && checksProblem(entry) === undefined;

// The scan's verdict at the pinned commit as a hover card: the short commit, and whichever check failed, in the scan's
// own words (the registry's text, verbatim, since a verdict with no stated reason is an opinion). Absent when it passed.
export const checksTip = (entry: RegistryEntry): Tip | undefined => {
    const checks = entry.checks;
    if (checks === undefined || checksProblem(entry) === undefined) {
        return undefined;
    }
    const failed =
        checks.manifest === `ok`
            ? { label: t(`sandbox.discoverListing.bundle`), value: checks.bundle }
            : { label: t(`sandbox.discoverListing.manifest`), value: checks.manifest };
    return {
        title: t(`sandbox.discoverListing.scanFailed`),
        tone: `warning`,
        rows: [{ label: t(`sandbox.words.commit`), value: checks.sha.slice(0, 7) }, failed],
    };
};

// The daemon reports the full sha now; one built before 2026-10-02 reports the short form, and the editor can run ahead
// of its daemon. A prefix of the pinned sha is that same commit, which is not the same as a different one.
const sameCommit = (installed: string, pinned: string | undefined): boolean => installed.length >= 7 && pinned?.startsWith(installed) === true;

// Blocked wins even over already-installed, since a reader who installed before a block needs to know most.
// Pointer validity is checked next, and only then does what's installed here decide the rest.
export const listingState = (entry: RegistryEntry, installed: readonly ExtensionSummary[]): ListingState => {
    if (entry.trust === `blocked`) {
        return { kind: `blocked`, reason: entry.trustReason ?? t(`sandbox.discoverListing.blockedByRegistry`) };
    }
    const here = installed.find((extension) => extensionIdOf(extension.manifest) === entry.name);
    if (entry.install === undefined) {
        return { kind: `unavailable`, reason: t(`sandbox.discoverListing.publishedSomewhereSandboxCant`) };
    }
    if (!isShaPinned(entry.install)) {
        // Reads and links fine; not a one-click install, since code runs trusted here and a branch isn't a promise.
        return { kind: `unavailable`, reason: t(`sandbox.discoverListing.listingNamesNoExact`) };
    }
    const audit = entry.admitted ? {} : { unaudited: true as const };
    if (here === undefined) {
        return { kind: `installable`, action: t(`sandbox.discoverListing.install`), ...audit };
    }
    // Built-in or workspace extensions here read as installed, never updatable: replacing either deletes work.
    if (here.source !== `installed` || sameCommit(here.commit, entry.install.ref)) {
        return { kind: `installed` };
    }
    return { kind: `update`, action: t(`sandbox.discoverListing.update`), installedRef: here.commit, installedId: here.id, ...audit };
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
            label: t(`sandbox.words.verified`),
            caption: ``,
            listings: listings.filter((listing) => listing.entry.trust === `verified`),
        },
        {
            id: `listed`,
            label: t(`sandbox.discoverListing.everythingPublished`),
            caption: ``,
            listings: listings.filter((listing) => listing.entry.trust !== `verified`),
        },
    ].filter((section) => section.listings.length > 0);

/** How many installed extensions this registry has a newer audited commit for, the hub row's badge. */
export const updateCount = (listings: readonly DiscoverListing[]): number =>
    listings.filter((listing) => listing.state.kind === `update` && listing.state.unaudited === undefined).length;
