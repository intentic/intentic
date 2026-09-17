import { activeLocale as active, type Locale, type MessageTree, registerCatalog, useT } from "@intentic/ui/i18n";
import type { Ref } from "vue";

// The kit's translator, reachable without the component barrel: `index.ts` pulls in every .vue component, which breaks
// an extension's node-environment tests that have no Vue plugin to parse SFCs with. A source-level door for in-repo
// extensions and their tests; a git-installed bundle resolves through the import map instead, which carries the same
// names, and either way the words come from the host's one instance rather than a second copy of vue-i18n.
//
// EVERY EXPORT BELOW IS ANNOTATED BY HAND, and that is load-bearing. This package is published; an inferred type here
// would name `vue-i18n` in the emitted declarations and make an outside extension author install a library they never
// call, just to type-check. Spelled out, the published types reach no further than `vue` and the locale table.

/**
 * Translating an extension's own keys. A plain string rather than a checked union: an extension's catalog belongs to
 * its own package, and no schema on this side has ever seen it.
 *
 * `plural` picks between the forms a message separates with `|` — `t("rounds", { count }, count)` — and is the count
 * the message interpolates, so English's two forms and Polish's three come out of the same call.
 */
export type ExtensionT = (key: string, values?: Record<string, unknown>, plural?: number) => string;

/**
 * One extension's translator, bound to the slice of the message tree the host mounted its catalog under. Keys are its
 * own — `t("panel.title")` for what lives at `ext.<id>.panel.title` — so nothing it writes can collide with the app's
 * keys or another extension's.
 *
 * Bind it once per extension rather than per component:
 *
 * ```ts
 * // src/i18n.ts
 * export const t = extensionT(extensionIdOf(manifest));
 * ```
 *
 * The messages themselves are declared on the extension's module (`export const messages`), which the host loads for
 * the reader's language before it calls `activate`.
 */
export const extensionT = (extensionId: string): ExtensionT => useT(`ext.${extensionId}`);

/**
 * Mounts an extension's own messages under its slice of the tree — what the HOST does before it calls `activate`, and
 * what a test that calls `activate` itself has to do instead, or every label it asserts on reads as a dotted key.
 *
 * ```ts
 * await registerExtensionMessages(extensionIdOf(manifest), messages);
 * ```
 *
 * `base` (English) is live the moment this returns; the promise resolves once the reader's actual language is in hand.
 */
export const registerExtensionMessages = (
    extensionId: string,
    messages: { readonly base: MessageTree; readonly load: (locale: string) => Promise<{ readonly default: MessageTree }> },
): Promise<void> => registerCatalog({ namespace: `ext.${extensionId}`, base: messages.base, load: (locale: string) => messages.load(locale) });

/** The language on screen, for the rare contribution that formats something itself. Read-only: change it with nothing. */
export const activeLocale: Readonly<Ref<Locale>> = active;

export type { Locale };
