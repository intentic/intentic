// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalog, MessageTree } from "@intentic/ui/i18n";

// The layer's one hard promise: NOTHING ON SCREEN CHANGES LANGUAGE UNTIL THE WORDS FOR IT ARE IN HAND. Every test
// here is a way that promise could be broken — a swap that leads its fetch, a catalog arriving after the swap, two
// choices racing — because the failure is invisible in code review and obvious to a reader, as a flash of English.
//
// The module holds one instance and one preference, so each test re-imports it against a cleared store rather than
// sharing state with the last.

/** A promise this test resolves by hand, so a language can be left mid-fetch and inspected there. */
const deferred = <T>(): { promise: Promise<T>; settle: (value: T) => void } => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, settle };
};

const freshI18n = async (stored?: string): Promise<typeof import("@intentic/ui/i18n")> => {
    localStorage.clear();
    if (stored !== undefined) {
        localStorage.setItem(`ui-locale`, stored);
    }
    vi.resetModules();
    return import(`@intentic/ui/i18n`);
};

/** A catalog whose non-English fetch this test controls. */
const heldCatalog = (namespace: string, base: MessageTree, held: Promise<{ default: MessageTree }>): Catalog => ({
    namespace,
    base,
    load: () => held,
});

// The app's own `t` is typed to the app's own keys, and these tests register fixture catalogs it has never heard of.
// Widening here rather than adding fixture keys to en.json, which would put test scaffolding in front of readers.
type AnyKeyT = (key: string) => string;

describe(`the language layer`, () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it(`keeps the old words on screen until the new ones have loaded`, async () => {
        const { activeLocale, registerCatalog, setLocale, t: typed } = await freshI18n();
        const t = typed as AnyKeyT;
        const pack = deferred<{ default: MessageTree }>();
        await registerCatalog(heldCatalog(`probe`, { greeting: `Hello` }, pack.promise));

        const switching = setLocale(`pl`);
        // The whole guarantee, in three assertions: the choice is made, the fetch is out, and the screen has not moved.
        expect(activeLocale.value).toBe(`en`);
        expect(t(`probe.greeting`)).toBe(`Hello`);
        expect(document.documentElement.lang).not.toBe(`pl`);

        pack.settle({ default: { greeting: `Cześć` } });
        await switching;

        expect(activeLocale.value).toBe(`pl`);
        expect(t(`probe.greeting`)).toBe(`Cześć`);
        expect(document.documentElement.lang).toBe(`pl`);
    });

    // An extension activates long after boot. Its own words have to arrive in the language already on screen, not in
    // English with a correction a frame later.
    it(`loads the active language for a catalog that registers after the switch`, async () => {
        const { registerCatalog, setLocale, t: typed } = await freshI18n();
        const t = typed as AnyKeyT;
        await setLocale(`pl`);

        await registerCatalog({
            namespace: `ext.probe`,
            base: { title: `Activity` },
            load: () => Promise.resolve({ default: { title: `Aktywność` } }),
        });

        expect(t(`ext.probe.title`)).toBe(`Aktywność`);
    });

    // A dotted namespace has to become real nesting, or `t("ext.probe.title")` walks into a tree that holds one
    // literal key called "ext.probe" and finds nothing.
    it(`mounts a dotted namespace as a path, not as a key with dots in it`, async () => {
        const { registerCatalog, t: typed } = await freshI18n();
        const t = typed as AnyKeyT;
        await registerCatalog({ namespace: `ext.probe`, base: { title: `Activity` }, load: () => Promise.reject(new Error(`unused`)) });

        expect(t(`ext.probe.title`)).toBe(`Activity`);
    });

    // Two choices in flight, the first one slower. The reader's last word wins; a late fetch must not repaint the
    // language they have already moved off.
    it(`ignores a fetch that lands after a newer choice`, async () => {
        const { activeLocale, registerCatalog, setLocale } = await freshI18n();
        const slow = deferred<{ default: MessageTree }>();
        const packs: Record<string, Promise<{ default: MessageTree }>> = {
            pl: slow.promise,
            de: Promise.resolve({ default: { greeting: `Hallo` } }),
        };
        await registerCatalog({
            namespace: `probe`,
            base: { greeting: `Hello` },
            load: (locale) => packs[locale] ?? Promise.resolve({ default: {} }),
        });

        const toPolish = setLocale(`pl`);
        await setLocale(`de`);
        expect(activeLocale.value).toBe(`de`);

        slow.settle({ default: { greeting: `Cześć` } });
        await toPolish;

        expect(activeLocale.value).toBe(`de`);
    });

    it(`starts in the language the store already holds, without being asked`, async () => {
        const { activeLocale, startI18n } = await freshI18n(`de`);
        await startI18n();

        expect(activeLocale.value).toBe(`de`);
    });

    it(`binds a namespaced translator so an extension writes its own keys`, async () => {
        const { registerCatalog, useT } = await freshI18n();
        await registerCatalog({ namespace: `ext.probe`, base: { greeting: `Hello {name}` }, load: () => Promise.reject(new Error(`unused`)) });

        const t = useT(`ext.probe`);
        expect(t(`greeting`, { name: `Ada` })).toBe(`Hello Ada`);
    });

    // The design system and the app both write into one tree from different packages; a namespace is what keeps them
    // from overwriting each other's keys.
    it(`keeps two catalogs' keys apart`, async () => {
        const { registerCatalog, t: typed } = await freshI18n();
        const t = typed as AnyKeyT;
        const load = (): Promise<{ default: MessageTree }> => Promise.reject(new Error(`unused`));
        await registerCatalog({ namespace: `probe`, base: { title: `Namespaced` }, load });
        await registerCatalog({ base: { title: `Root` }, load });

        expect(t(`probe.title`)).toBe(`Namespaced`);
        expect(t(`title`)).toBe(`Root`);
    });
});
