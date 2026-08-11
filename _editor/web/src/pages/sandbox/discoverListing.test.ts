import type { RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { checksOk, checksProblem, listingSections, listingState, splitListingName, toListing, updateCount } from "./discoverListing";

const SHA = `a`.repeat(40);
const OTHER_SHA = `b`.repeat(40);

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
    name: `radarsu.paperwork`,
    kind: `extension`,
    trust: `listed`,
    tier: `free`,
    install: { url: `https://github.com/radarsu/intentic-paperwork.git`, ref: SHA },
    ...over,
});

// Only the three fields the join reads. The daemon's real summary is much wider; widening this fixture would
// be asserting things about the contract rather than about the join.
const installedAs = (id: string, commit: string, source: ExtensionSummary[`source`] = `installed`): ExtensionSummary => {
    const [publisher = ``, name = ``] = id.split(`.`);
    return { manifest: { publisher, name }, commit, source } as unknown as ExtensionSummary;
};

describe(`what a registry row becomes against this sandbox`, () => {
    test(`nothing installed under that identity ⇒ it is there to be installed`, () => {
        expect(listingState(entry(), [])).toEqual({ kind: `installable`, action: `Install` });
    });

    test(`matches on the manifest identity, not on what the installer happened to name it`, () => {
        // The whole point of the key: this sandbox called it "paperwork" in the capability box, and the
        // listing is keyed radarsu.paperwork. Matching the typed name would offer to install it again.
        const installed = [installedAs(`radarsu.paperwork`, SHA)];
        expect(listingState(entry(), installed).kind).toBe(`installed`);
    });

    test(`a different commit at the same identity is an update, and says which commit is here`, () => {
        const state = listingState(entry(), [installedAs(`radarsu.paperwork`, OTHER_SHA)]);
        expect(state).toEqual({ kind: `update`, action: `Update`, installedRef: OTHER_SHA });
    });

    test(`an image-baked or workspace extension of the same name is installed, never updatable`, () => {
        // Replacing either with a registry commit would be offering to delete somebody's work: one ships with
        // the image, the other is a directory being edited in place.
        for (const source of [`builtin`, `workspace`] as const) {
            expect(listingState(entry(), [installedAs(`radarsu.paperwork`, OTHER_SHA, source)]).kind).toBe(`installed`);
        }
    });

    test(`blocked wins over everything, including already having it`, () => {
        // The person who installed it before it was blocked is exactly the reader who has to be told.
        const blocked = entry({ trust: `blocked`, trustReason: `Exfiltrates workspace files.` });
        const state = listingState(blocked, [installedAs(`radarsu.paperwork`, SHA)]);
        expect(state).toEqual({ kind: `blocked`, reason: `Exfiltrates workspace files.` });
    });

    test(`a blocked row with no stated reason still says something`, () => {
        expect(listingState(entry({ trust: `blocked` }), []).reason).toBeTruthy();
    });

    test(`a pointer with no exact commit reads, but cannot be installed in one click`, () => {
        const branch = entry({ install: { url: `https://github.com/o/e.git`, ref: `main` } });
        const state = listingState(branch, []);
        expect(state.kind).toBe(`unavailable`);
        expect(state.reason).toContain(`no exact commit`);
    });

    test(`a source this daemon cannot clone is unavailable rather than absent`, () => {
        // An entry that exists and can't be installed is information; a missing row is a bug report.
        expect(listingState(entry({ install: undefined }), []).kind).toBe(`unavailable`);
    });

    test(`every state that cannot be acted on explains itself`, () => {
        const dead = [entry({ trust: `blocked` }), entry({ install: undefined }), entry({ install: { url: `https://x/y.git` } })];
        for (const row of dead) {
            expect(listingState(row, []).reason).toBeTruthy();
        }
    });
});

describe(`what last night's scan is allowed to claim`, () => {
    test(`no checks at all says nothing — most registries run no scanner`, () => {
        expect(checksProblem(entry())).toBeUndefined();
        expect(checksOk(entry())).toBe(false);
    });

    test(`a bundle-less extension loads fine — "none" is a daemon-only pack, not a fault`, () => {
        expect(checksOk(entry({ checks: { sha: SHA, manifest: `ok`, bundle: `none` } }))).toBe(true);
    });

    test(`a manifest problem is reported before a bundle one, and quotes the scan verbatim`, () => {
        const broken = entry({ checks: { sha: SHA, manifest: `the manifest does not parse`, bundle: `missing` } });
        expect(checksProblem(broken)).toBe(`At the pinned commit, the manifest does not parse`);
    });

    test(`a bundle that cannot load is a problem`, () => {
        expect(checksProblem(entry({ checks: { sha: SHA, manifest: `ok`, bundle: `is missing` } }))).toContain(`the bundle is missing`);
    });
});

describe(`how the list is grouped and searched`, () => {
    const listings = [
        toListing(entry({ name: `radarsu.paperwork`, description: `Invoices and receipts, filed.`, trust: `verified` }), []),
        toListing(entry({ name: `radarsu.homelab`, description: `Four CLI cards for a home server.` }), []),
        toListing(entry({ name: `acme.standup`, description: `Yesterday, today, blockers.` }), []),
    ];

    test(`verified leads, and each group keeps the caption the website uses`, () => {
        const sections = listingSections(listings);
        expect(sections.map((section) => section.id)).toEqual([`verified`, `listed`]);
        expect(sections[0]?.listings).toHaveLength(1);
        expect(sections[1]?.caption).toContain(`nobody has read the code`);
    });

    test(`a group nothing landed in is not a heading over nothing`, () => {
        expect(listingSections(listings.slice(1)).map((section) => section.id)).toEqual([`listed`]);
        expect(listingSections([])).toHaveLength(0);
    });

    test(`the filter reaches the description, not just the name`, () => {
        // Somebody looking for "invoices" is looking for paperwork and does not know it is called that.
        expect(listings[0]?.search).toContain(`invoices`);
        expect(listings.filter((listing) => listing.search.includes(`radarsu`))).toHaveLength(2);
    });

    test(`the update count is what the hub row badges`, () => {
        const withUpdate = [
            toListing(entry({ name: `radarsu.paperwork` }), [installedAs(`radarsu.paperwork`, OTHER_SHA)]),
            toListing(entry({ name: `radarsu.homelab` }), []),
        ];
        expect(updateCount(withUpdate)).toBe(1);
    });
});

describe(`drawing a name nobody has seen before`, () => {
    test(`splits publisher from extension`, () => {
        expect(splitListingName(`radarsu.paperwork`)).toEqual({ publisher: `radarsu`, title: `paperwork` });
    });

    test(`a name this app would never install still draws as something`, () => {
        expect(splitListingName(`oddity`)).toEqual({ publisher: ``, title: `oddity` });
    });
});
