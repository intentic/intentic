import { describe, expect, it } from "vitest";
import { compareEntries, type RegistryEntry, RegistryFactsSchema, RegistryFileSchema, resolveRegistry } from "./registry.js";

const SHA = "9f2c1ab0d4e5f60718293a4b5c6d7e8f90a1b2c3";
const REGISTRY = "https://github.com/intentic/registry";

const file = RegistryFileSchema.parse({
    name: `intentic`,
    plugins: [
        { name: `incidents`, kind: `extension`, trust: `verified`, source: { source: `github`, repo: `acme/incidents`, sha: SHA } },
        { name: `linear`, kind: `extension`, source: { source: `github`, repo: `acme/linear`, sha: SHA } },
        { name: `evil`, kind: `extension`, trust: `blocked`, trustReason: `exfiltrates workspace secrets`, source: { source: `github`, repo: `bad/evil` } },
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

    it(`defaults an unstated trust to listed and an unstated kind to plugin`, () => {
        const entries = resolveRegistry(RegistryFileSchema.parse({ name: `x`, plugins: [{ name: `a`, source: `./a` }] }), undefined, REGISTRY);
        expect(entries[0]).toMatchObject({ trust: `listed`, kind: `plugin` });
    });

    // Blocked rows must survive the resolve — deleting them is what hides a warning from the people who
    // already installed the thing.
    it(`keeps a blocked entry, with its reason`, () => {
        const blocked = resolveRegistry(file, undefined, REGISTRY).find((entry) => entry.name === `evil`);
        expect(blocked).toMatchObject({ trust: `blocked`, trustReason: `exfiltrates workspace secrets` });
    });
});

describe(`compareEntries`, () => {
    const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({ name: `x`, kind: `extension`, trust: `listed`, ...over });

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
