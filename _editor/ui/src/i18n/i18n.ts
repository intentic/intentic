import { computed, type ComputedRef, watch, type App } from "vue";
import { createI18n } from "vue-i18n";
import { definePreference } from "../composables/preference.js";
import { setFormatLocale } from "../lib/format.js";
import { BASE_LOCALE, isLocale, type Locale, LOCALE_KEY, negotiate } from "./locales.js";

/** A slice of the message tree as it is authored: nested objects down to strings. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/**
 * One package's contribution to the message tree. `base` is compiled in, every other language is one chunk fetched
 * on demand, so shipping a fifth language costs the app's initial bundle nothing.
 */
export interface Catalog {
    /**
     * Where this slice mounts, dotted (`ui`, `ext.projects`). Omitted means the root, which only the app itself
     * uses — everything else is namespaced, so two packages can never claim the same key.
     */
    readonly namespace?: string;
    /** The `en` messages, imported statically: the fallback for a key no other language has yet must never be a fetch. */
    readonly base: MessageTree;
    /** One chunk per language. Called at most once per language, and never for `en`. */
    readonly load: (locale: Exclude<Locale, typeof BASE_LOCALE>) => Promise<{ readonly default: MessageTree }>;
}

// NOT `legacy`, and NOT a per-component scope. One global instance, one language, ONE WAY TO REACH IT: `useT()` in a
// component's script, `t` in a plain module. Both read this module directly rather than an injected instance, which
// is the property that matters — a component that translates still renders under a bare `createApp`, so no component
// test has to install a plugin to mount the thing it is testing.
//
// `globalInjection` is off for the same reason: `$t` in a template would work in the app and fail in exactly those
// tests, which is a worse failure than not having it. `installI18n` is still worth calling, but only for `<i18n-t>`,
// the component that wraps a slot inside a translated sentence.
//
// Component-local `useI18n({ messages })` is unavailable on purpose — it inlines every language into the component's
// own chunk, which is exactly the bundle growth this layer exists to avoid.
//
// The message compiler is kept (no `@intlify/unplugin-vue-i18n` precompile step). It has to be: extensions installed
// from a repository ship plain JSON this app has never seen at build time, and without the compiler their strings
// cannot render at all. Given it is bundled anyway, precompiling our own would only trade sub-millisecond parse time
// for a larger AST payload and a plugin in four Vite configs.
//
// No `messages` here, and it cannot be one: vue-i18n types that option against the augmented `DefineLocaleMessage`,
// so every slice a package declares — `ui`, and each extension's — would have to be present in this literal. The tree
// is assembled the other way round, by `registerCatalog` calling `mergeLocaleMessage` as each package imports, which
// is also the only shape that works for a catalog arriving at runtime.

// A `|` message is chosen by INDEX, and the index a count maps to is the language's own grammar. vue-i18n's default
// rule is English's — one form for 1, another for everything else — which is right for German and Spanish and wrong
// for the other two. Only languages that disagree with it are listed; a language absent here gets the default.
const pluralRules = {
    // Three forms, because Polish has three: "1 plik", "2 pliki", "5 plików". The teens are the exception the
    // modulo-10 test alone gets wrong — 12, 13, 14 take the third form, while 22, 23, 24 take the second.
    pl: (choice: number, choicesLength: number): number => {
        const count = Math.abs(choice);
        if (count === 1) {
            return 0;
        }
        // A message a translator wrote with two forms only: keep the second for everything that is not exactly one,
        // rather than indexing past the end of what it carries.
        if (choicesLength < 3) {
            return 1;
        }
        const tens = count % 10;
        const hundreds = count % 100;
        return tens >= 2 && tens <= 4 && !(hundreds >= 12 && hundreds <= 14) ? 1 : 2;
    },
    // French counts zero as singular — "0 fichier", not "0 fichiers" — which is the one place it parts from English.
    fr: (choice: number): number => (Math.abs(choice) <= 1 ? 0 : 1),
};

const i18n = createI18n({
    legacy: false,
    globalInjection: false,
    locale: BASE_LOCALE,
    fallbackLocale: BASE_LOCALE,
    pluralRules,
});

const catalogs = new Set<Catalog>();

// Chunks already in the tree, keyed language-and-namespace, so a catalog that arrives after boot (an extension
// activating) fetches only what it is missing, and two callers asking at once share one fetch.
const merged = new Map<string, Promise<void>>();

const slotOf = (locale: Locale, catalog: Catalog): string => `${locale}/${catalog.namespace ?? ``}`;

// A dotted namespace has to become real nesting: vue-i18n resolves `ext.projects.title` by walking the tree, so a
// literal `"ext.projects"` key would never be found.
const nest = (namespace: string | undefined, tree: MessageTree): MessageTree =>
    namespace === undefined ? tree : namespace.split(`.`).reduceRight<MessageTree>((inner, key) => ({ [key]: inner }), tree);

// vue-i18n types this argument against the augmented schema, and a catalog is by definition a slice that schema has
// not seen yet — an extension's, or the app's own before its `declare module` block is in the program. So the tree
// crosses the boundary untyped, and `t`'s key checking is what re-establishes safety on the way out. Derived from
// the function rather than written out, so the cast cannot drift from whatever signature the library actually has.
type MergeableMessages = Parameters<typeof i18n.global.mergeLocaleMessage>[1];

const merge = (locale: Locale, catalog: Catalog, tree: MessageTree): void => {
    i18n.global.mergeLocaleMessage(locale, nest(catalog.namespace, tree) as MergeableMessages);
};

const fetchInto = (locale: Locale, catalog: Catalog): Promise<void> => {
    const slot = slotOf(locale, catalog);
    const running = merged.get(slot);
    if (running !== undefined) {
        return running;
    }
    const job = catalog.load(locale as Exclude<Locale, typeof BASE_LOCALE>).then((module) => merge(locale, catalog, module.default));
    merged.set(slot, job);
    return job;
};

/** The language the reader has chosen. Changing it starts a fetch; nothing on screen moves until that fetch lands. */
const preference = definePreference<Locale>({
    key: LOCALE_KEY,
    // No stored choice means the browser's own preference order decides, which is what the pre-paint script in
    // index.html does with the same function.
    read: (raw) => (isLocale(raw) ? raw : negotiate(globalThis.navigator?.languages ?? [])),
    write: (value) => value,
});

/** The language on screen. Trails `preference` by exactly one chunk fetch, and never leads it. */
export const activeLocale: ComputedRef<Locale> = computed(() => i18n.global.locale.value as Locale);

const activate = async (locale: Locale): Promise<void> => {
    await Promise.all([...catalogs].map((catalog) => fetchInto(locale, catalog)));
    // A choice made while this one was in flight wins: a slow fetch resolving late must not repaint the language
    // the reader has already moved on from.
    if (preference.value !== locale) {
        return;
    }
    // THE ONLY PLACE THE VISIBLE LANGUAGE CHANGES, and it runs in one tick after every message is in hand. Swapping
    // the locale before the fetch is what makes an app flash keys, or English, on its way to the right words.
    i18n.global.locale.value = locale;
    setFormatLocale(locale);
    globalThis.document?.documentElement.setAttribute(`lang`, locale);
};

// Another window changing the language reaches this ref through BroadcastChannel; it has to load and swap here too.
// Caught, unlike `setLocale`'s promise, because nobody is holding this one: a chunk that fails to arrive leaves the
// reader in the language already on screen, which is the same outcome as one still in flight.
watch(preference, (locale) => void activate(locale).catch(() => undefined));

/**
 * Adds a package's messages to the tree. `en` is live the moment this returns; the promise resolves once the
 * reader's actual language has been fetched, which is what a caller rendering the new strings must await.
 */
export const registerCatalog = (catalog: Catalog): Promise<void> => {
    catalogs.add(catalog);
    merge(BASE_LOCALE, catalog, catalog.base);
    merged.set(slotOf(BASE_LOCALE, catalog), Promise.resolve());
    // Keyed on the CHOICE, not on what is painted: registration happens while modules import, before the boot below
    // has swapped anything, and starting the fetch here means it is already in flight when the boot awaits it.
    return preference.value === BASE_LOCALE ? Promise.resolve() : fetchInto(preference.value, catalog);
};

/** Change language. Persists the choice, mirrors it to every other window, and repaints once — never before. */
export const setLocale = (locale: Locale): Promise<void> => {
    preference.value = locale;
    // `watch` above has already started this same activation; `fetchInto` dedupes, so both await one fetch.
    return activate(locale);
};

/**
 * Brings the stored language on screen. Call once from `main.ts` and AWAIT IT BEFORE MOUNTING: that await is the
 * whole no-flicker guarantee on a cold load, and it costs nothing for a reader who is on `en`.
 */
export const startI18n = (): Promise<void> => activate(preference.value);

export const installI18n = (app: App): void => {
    app.use(i18n);
};

/**
 * Translating one of this app's own keys. Not a checked union, whatever the schema suggests — vue-i18n's `t` takes any
 * string — so the gate on a key no catalog has is `_tools/checks/i18n-keys.mjs`.
 */
export type TypedT = typeof i18n.global.t;

/**
 * Translating someone else's. An extension's catalog belongs to its own package, so the host's schema has never seen
 * its keys and no amount of typing here could check them — the honest shape is a string.
 *
 * `plural` picks between the forms a message separates with `|`, and is the count the message also interpolates.
 */
export type LooseT = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/**
 * The translator. With no argument it is the app's own, typed against `en`; with a namespace it is bound to someone
 * else's slice, so an extension writes `t("title")` for what lands at `ext.projects.title`.
 *
 * Not a Vue hook despite the name — it reads a module singleton, so it is equally callable from a plain module,
 * which is how an extension binds one `t` once instead of in every component.
 */
export function useT(): TypedT;
export function useT(namespace: string): LooseT;
export function useT(namespace?: string): TypedT | LooseT {
    if (namespace === undefined) {
        return i18n.global.t;
    }
    // The one cast in this module, and it buys the line above: `t` is typed to the app's own key union, and an
    // extension's keys are by definition outside it.
    const translate = i18n.global.t as unknown as LooseT;
    // Each argument is passed only when there is one: vue-i18n reads a present-but-undefined second argument as an
    // empty interpolation set, not as an absent one, and a third as plural form zero.
    return (key: string, values?: Record<string, unknown>, plural?: number): string => {
        const path = `${namespace}.${key}`;
        if (plural !== undefined) {
            return translate(path, values ?? {}, plural);
        }
        return values === undefined ? translate(path) : translate(path, values);
    };
}

/** Translate outside a component — a router guard, a notice, a plain module. Reads the language live at call time. */
export const t: TypedT = i18n.global.t;

export { BASE_LOCALE, isLocale, type Locale, LOCALE_CODES, LOCALE_KEY, LOCALES, negotiate } from "./locales.js";
