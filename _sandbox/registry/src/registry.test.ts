import { describe, expect, it } from "vitest";
import {
    compareEntries,
    isOfficialRegistryUrl,
    OFFICIAL_DETERMINISTIC_SCANNER,
    OFFICIAL_DETERMINISTIC_SCANNER_VERSION,
    OFFICIAL_DETERMINISTIC_SCAN_POLICY,
    OFFICIAL_SECURITY_REVIEW_POLICY,
    OFFICIAL_SECURITY_REVIEWER,
    type RegistryEntry,
    RegistryFactsSchema,
    RegistryFileSchema,
    resolveRegistry,
} from "./registry.js";

const SHA = "9f2c1ab0d4e5f60718293a4b5c6d7e8f90a1b2c3";
const REGISTRY = "https://github.com/intentic/registry";
const REVIEW = {
    sha: SHA,
    url: `https://github.com/acme/incidents.git`,
    policy: OFFICIAL_SECURITY_REVIEW_POLICY,
    reviewer: OFFICIAL_SECURITY_REVIEWER,
    reviewedAt: "2026-08-01T00:00:00.000Z",
    runId: "run-1",
    deterministic: {
        policy: OFFICIAL_DETERMINISTIC_SCAN_POLICY,
        scanner: OFFICIAL_DETERMINISTIC_SCANNER,
        version: OFFICIAL_DETERMINISTIC_SCANNER_VERSION,
        runId: `workflow-1`,
    },
};

const file = RegistryFileSchema.parse({
    name: `intentic`,
    plugins: [
        {
            name: `incidents`,
            kind: `extension`,
            trust: `verified`,
            securityReview: REVIEW,
            source: { source: `github`, repo: `acme/incidents`, sha: SHA },
        },
        { name: `linear`, kind: `extension`, source: { source: `github`, repo: `acme/linear`, sha: SHA } },
        {
            name: `evil`,
            kind: `extension`,
            trust: `blocked`,
            trustReason: `exfiltrates workspace secrets`,
            source: { source: `github`, repo: `bad/evil` },
        },
    ],
});

describe(`resolveRegistry`, () => {
    it(`joins upstream facts onto the curated entries by name`, () => {
        const facts = RegistryFactsSchema.parse({
            scannedAt: `2026-08-01T00:00:00.000Z`,
            entries: [{ name: `linear`, stars: 42, pushedAt: `2026-07-30T12:00:00Z` }],
        });
        const entries = resolveRegistry(file, facts, REGISTRY);
        expect(entries.find((entry) => entry.name === `linear`)).toMatchObject({ stars: 42, pushedAt: `2026-07-30T12:00:00Z` });
        // A curated entry the scanner has no facts for is still a complete row.
        expect(entries.find((entry) => entry.name === `incidents`)?.stars).toBeUndefined();
    });

    // Most registries are six internal extensions in a private repo and run no scanner at all.
    it(`resolves with no generated file at all`, () => {
        expect(resolveRegistry(file, undefined, REGISTRY)).toHaveLength(3);
    });

    it(`admits official extensions only when both automated checks match their complete source identity`, () => {
        const entries = resolveRegistry(file, undefined, REGISTRY);
        expect(entries.find((entry) => entry.name === `incidents`)?.admitted).toBe(true);
        expect(entries.find((entry) => entry.name === `linear`)?.admitted).toBe(false);
        expect(entries.find((entry) => entry.name === `evil`)?.admitted).toBe(false);
    });

    it(`does not admit deterministic evidence from an old policy or scanner version`, () => {
        for (const deterministic of [
            { ...REVIEW.deterministic, policy: `intentic-extension-deterministic-v0` },
            { ...REVIEW.deterministic, version: `0.71.0` },
        ]) {
            const registry = RegistryFileSchema.parse({
                name: `intentic`,
                plugins: [
                    {
                        name: `incidents`,
                        kind: `extension`,
                        securityReview: { ...REVIEW, deterministic },
                        source: { source: `github`, repo: `acme/incidents`, sha: SHA },
                    },
                ],
            });
            expect(resolveRegistry(registry, undefined, REGISTRY)[0]?.admitted).toBe(false);
        }
    });

    it(`leaves a third-party registry as its own trust boundary`, () => {
        const entries = resolveRegistry(file, undefined, `https://github.com/acme/internal-registry`);
        expect(entries.find((entry) => entry.name === `linear`)?.admitted).toBe(true);
    });

    it(`defaults an unstated trust to listed, an unstated kind to plugin, and an unstated tier to free`, () => {
        const entries = resolveRegistry(RegistryFileSchema.parse({ name: `x`, plugins: [{ name: `a`, source: `./a` }] }), undefined, REGISTRY);
        expect(entries[0]).toMatchObject({ trust: `listed`, kind: `plugin`, tier: `free` });
    });

    it(`carries a premium tier through the resolve`, () => {
        const premium = RegistryFileSchema.parse({
            name: `x`,
            plugins: [{ name: `acme.research`, kind: `extension`, tier: `premium`, source: { source: `github`, repo: `acme/research`, sha: SHA } }],
        });
        expect(resolveRegistry(premium, undefined, REGISTRY)[0]?.tier).toBe(`premium`);
    });

    // Blocked rows must survive the resolve — deleting them is what hides a warning from the people who
    /* The staleness rule the checks ride on: a fact is bound to the sha it was derived from, and a listing
     * repointed since the last scan renders no checks at all — the honest gap — rather than yesterday's verdict
     * describing today's pointer. */
    it(`joins checks only when they were derived from the sha the listing still pins`, () => {
        const facts = RegistryFactsSchema.parse({
            scannedAt: `2026-08-01T00:00:00.000Z`,
            entries: [
                { name: `linear`, checks: { sha: SHA, manifest: `ok`, bundle: `ok`, engines: `^2.0.0` } },
                { name: `incidents`, checks: { sha: `b`.repeat(40), manifest: `ok`, bundle: `ok` } },
            ],
        });
        const entries = resolveRegistry(file, facts, REGISTRY);
        expect(entries.find((entry) => entry.name === `linear`)?.checks).toEqual({ sha: SHA, manifest: `ok`, bundle: `ok`, engines: `^2.0.0` });
        expect(entries.find((entry) => entry.name === `incidents`)?.checks).toBeUndefined();
    });

    // already installed the thing.
    it(`keeps a blocked entry, with its reason`, () => {
        const blocked = resolveRegistry(file, undefined, REGISTRY).find((entry) => entry.name === `evil`);
        expect(blocked).toMatchObject({ trust: `blocked`, trustReason: `exfiltrates workspace secrets` });
    });
});

describe(`compareEntries`, () => {
    const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
        name: `x`,
        kind: `extension`,
        trust: `listed`,
        admitted: true,
        tier: `free`,
        ...over,
    });

    it(`puts verified first even when it has fewer stars`, () => {
        const sorted = [entry({ name: `popular`, stars: 900 }), entry({ name: `checked`, trust: `verified`, stars: 1 })].toSorted(compareEntries);
        expect(sorted.map((e) => e.name)).toEqual([`checked`, `popular`]);
    });

    it(`ranks by stars within a trust tier`, () => {
        const sorted = [entry({ name: `few`, stars: 3 }), entry({ name: `many`, stars: 30 })].toSorted(compareEntries);
        expect(sorted.map((e) => e.name)).toEqual([`many`, `few`]);
    });

    // The common case at launch: everything on zero stars, so recency is what actually orders the page.
    it(`breaks star ties on recency, then on name`, () => {
        const sorted = [
            entry({ name: `stale`, pushedAt: `2026-01-01T00:00:00Z` }),
            entry({ name: `fresh`, pushedAt: `2026-07-31T00:00:00Z` }),
            entry({ name: `undated` }),
        ].toSorted(compareEntries);
        expect(sorted.map((e) => e.name)).toEqual([`fresh`, `stale`, `undated`]);
    });
});

describe(`security review invariants`, () => {
    it(`refuses a verified row with no evidence and a blocked row with no reason`, () => {
        expect(
            RegistryFileSchema.safeParse({
                name: `x`,
                plugins: [{ name: `verified`, kind: `extension`, trust: `verified`, source: { source: `github`, repo: `x/v`, sha: SHA } }],
            }).success,
        ).toBe(false);
        expect(
            RegistryFileSchema.safeParse({
                name: `x`,
                plugins: [{ name: `blocked`, kind: `extension`, trust: `blocked`, source: { source: `github`, repo: `x/b`, sha: SHA } }],
            }).success,
        ).toBe(false);
    });

    it(`refuses evidence copied from another repository or subdirectory at the same sha`, () => {
        for (const entry of [
            {
                name: `changed-repository`,
                kind: `extension`,
                trust: `listed`,
                securityReview: REVIEW,
                source: { source: `github`, repo: `x/changed`, sha: SHA },
            },
            {
                name: `changed-path`,
                kind: `extension`,
                trust: `listed`,
                securityReview: { ...REVIEW, url: `https://github.com/acme/monorepo.git`, path: `packages/other` },
                source: {
                    source: `git-subdir`,
                    url: `https://github.com/acme/monorepo.git`,
                    path: `packages/changed`,
                    sha: SHA,
                },
            },
        ]) {
            expect(RegistryFileSchema.safeParse({ name: `x`, plugins: [entry] }).success).toBe(false);
        }
    });

    it(`recognizes harmless spellings of the official registry so they cannot bypass admission`, () => {
        expect(isOfficialRegistryUrl(`https://github.com/intentic/registry.git/`)).toBe(true);
        expect(isOfficialRegistryUrl(`http://github.com/intentic/registry`)).toBe(true);
        expect(isOfficialRegistryUrl(`git@github.com:intentic/registry.git`)).toBe(true);
        expect(isOfficialRegistryUrl(`https://github.com/INTENTIC/REGISTRY`)).toBe(true);
        expect(isOfficialRegistryUrl(`https://github.com/intentic/registry-copy`)).toBe(false);
    });
});
