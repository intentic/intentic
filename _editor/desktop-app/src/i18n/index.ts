import { type Catalog, registerCatalog } from "@intentic/ui/i18n";
import base from "./locales/en.json";

// The desktop shell's own words: the setup window, the tray, the close confirmation. Its own catalog rather than the
// editor's, because this bundle is the Tauri shell alone — it never loads the web app's code, so it must not carry
// the web app's messages either.

// No `declare module "vue-i18n"` here: this package reaches the layer through @intentic/ui and does not depend on
// vue-i18n itself, so it has no module to augment — and the augmentation buys no key checking anyway (see
// _tools/checks/i18n-keys.mjs, which is what actually refuses a key no catalog has).

/**
 * Adds the shell's words to the message tree. Awaited by `main.ts` before `startI18n`, so nothing paints in the wrong
 * language.
 *
 * The specifier below has to stay a literal template: that is what lets the bundler enumerate `./locales/*.json` and
 * emit one chunk per language, none of which is in the initial download.
 */
export const registerDesktopCatalog = (): Promise<void> =>
    registerCatalog({
        namespace: `desktop`,
        base,
        load: (locale) => import(`./locales/${locale}.json`),
    } satisfies Catalog);
