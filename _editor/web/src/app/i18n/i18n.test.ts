import "@intentic/testing/dom";
import { describe, it, expect, beforeEach } from "bun:test";
import { freshImport } from "@intentic/testing/bun";
import { BASE_LOCALE, type Catalog, type MessageTree } from "@intentic/ui/i18n";
import { setFormatLocale } from "@intentic/ui/format";

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

// The layer's state lives in the module the package barrel re-exports, so that is what a case evaluates afresh;
// re-evaluating the barrel alone would hand back the same instance and the same catalogs.
const I18N = new URL(`./i18n.ts`, import.meta.resolve("@intentic/ui/i18n")).href;

const freshI18n = (stored?: string): Promise<typeof import("@intentic/ui/i18n")> => {
    localStorage.clear();
    if (stored !== undefined) {
        localStorage.setItem(`ui-locale`, stored);
    }
    // The date formatter is one instance every layer shares, so a case that counts its readings has to open on the
    // base locale rather than wherever the last one left it.
    setFormatLocale(BASE_LOCALE);
    return freshImport<typeof import("@intentic/ui/i18n")>(I18N, import.meta.url);
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

    // THE ONE THAT SHIPPED BROKEN. Every assertion above reads `t` after the switch and passed while the app on
    // screen did not change: the words were right the next time anything asked for them, and nothing asked. What a
    // render actually needs is a DEPENDENCY, so these drive the two halves through `watchEffect` — the same thing a
    // component's render is — and count the runs rather than reading the value back.
    //
    // `formatDate` was the half that had none: `setFormatLocale` wrote a plain module variable, so the dates beside
    // freshly-translated words stayed in the language before until something unrelated re-rendered them.
    describe(`a language change reaches what is already drawn`, () => {
        const catalog = (): Catalog => ({
            namespace: `probe`,
            base: { greeting: `Hello` },
            load: () => Promise.resolve({ default: { greeting: `Cześć` } }),
        });

        it(`re-runs a render that translates`, async () => {
            const { registerCatalog, setLocale, useT } = await freshI18n();
            const { watchEffect, nextTick } = await import(`vue`);
            await registerCatalog(catalog());
            const t = useT(`probe`);

            const seen: string[] = [];
            const stop = watchEffect(() => seen.push(t(`greeting`)));
            await setLocale(`pl`);
            await nextTick();
            stop();

            expect(seen).toEqual([`Hello`, `Cześć`]);
        });

        it(`re-runs a render that formats a date`, async () => {
            const { registerCatalog, setLocale } = await freshI18n();
            const { watchEffect, nextTick } = await import(`vue`);
            const { formatDate } = await import(`@intentic/ui/format`);
            await registerCatalog(catalog());

            const seen: string[] = [];
            const stop = watchEffect(() => seen.push(formatDate(Date.UTC(2026, 8, 17))));
            await setLocale(`pl`);
            await nextTick();
            stop();

            // The words are CLDR's; what this pins is that there are TWO readings and they differ.
            expect(seen).toHaveLength(2);
            expect(seen[1]).not.toBe(seen[0]);
        });
    });

    // A `|` message is picked by INDEX, and the index a count maps to is the language's grammar, not English's.
    // vue-i18n's default rule is English's, so without the rules registered in `createI18n` a Polish reader gets
    // "2 plików" where the language wants "2 pliki", and a French one "0 fichiers" where it wants "0 fichier".
    describe(`a count picks the form its own language uses`, () => {
        const counted = (forms: string): Catalog => ({
            namespace: `probe`,
            base: { files: `{count} file | {count} files` },
            load: () => Promise.resolve({ default: { files: forms } }),
        });

        it(`gives Polish its three forms, teens included`, async () => {
            const { registerCatalog, setLocale, t: typed } = await freshI18n();
            const t = typed as unknown as (key: string, values: Record<string, unknown>, plural: number) => string;
            await registerCatalog(counted(`{count} plik | {count} pliki | {count} plików`));
            await setLocale(`pl`);

            const files = (count: number): string => t(`probe.files`, { count }, count);
            expect(files(1)).toBe(`1 plik`);
            expect(files(2)).toBe(`2 pliki`);
            expect(files(5)).toBe(`5 plików`);
            // The exception the modulo-10 test alone gets wrong: 12–14 take the third form, 22–24 the second.
            expect(files(13)).toBe(`13 plików`);
            expect(files(22)).toBe(`22 pliki`);
            // Zero is the genitive plural, not the singular.
            expect(files(0)).toBe(`0 plików`);
        });

        it(`counts zero as singular in French, as the language does`, async () => {
            const { registerCatalog, setLocale, t: typed } = await freshI18n();
            const t = typed as unknown as (key: string, values: Record<string, unknown>, plural: number) => string;
            await registerCatalog(counted(`{count} fichier | {count} fichiers`));
            await setLocale(`fr`);

            const files = (count: number): string => t(`probe.files`, { count }, count);
            expect(files(0)).toBe(`0 fichier`);
            expect(files(1)).toBe(`1 fichier`);
            expect(files(2)).toBe(`2 fichiers`);
        });

        it(`leaves German on the English split it shares`, async () => {
            const { registerCatalog, setLocale, t: typed } = await freshI18n();
            const t = typed as unknown as (key: string, values: Record<string, unknown>, plural: number) => string;
            await registerCatalog(counted(`{count} Datei | {count} Dateien`));
            await setLocale(`de`);

            const files = (count: number): string => t(`probe.files`, { count }, count);
            expect(files(1)).toBe(`1 Datei`);
            expect(files(2)).toBe(`2 Dateien`);
            expect(files(0)).toBe(`0 Dateien`);
        });
    });
});
