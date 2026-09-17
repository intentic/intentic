import { activeLocale as active, type Locale, useT } from "@intentic/ui/i18n";
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
 */
export type ExtensionT = (key: string, values?: Record<string, unknown>) => string;

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

/** The language on screen, for the rare contribution that formats something itself. Read-only: change it with nothing. */
export const activeLocale: Readonly<Ref<Locale>> = active;

export type { Locale };
