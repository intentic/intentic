import { type Catalog, registerCatalog } from "@intentic/ui/i18n";
import base from "./locales/en.json";

// This page's own words, plus the editor's — it compiles the app's chat components in, and their labels are keys in
// the editor's catalog, so registering only this one would draw `chat.chatToolCard.more` at a stranger.

// No `declare module "vue-i18n"` here: this package reaches the layer through @intentic/ui and does not depend on
// vue-i18n itself, so it has no module to augment — and the augmentation buys no key checking anyway (see
// _tools/checks/i18n-keys.mjs, which is what actually refuses a key no catalog has).

/**
 * Adds this page's words to the message tree. Awaited by `main.ts` before `startI18n`, so a stranger's browser never
 * watches the page change language.
 *
 * The specifier below has to stay a literal template: that is what lets the bundler enumerate `./locales/*.json` and
 * emit one chunk per language, none of which is in the initial download.
 */
export const registerShareCatalog = (): Promise<void> =>
    registerCatalog({
        namespace: `share`,
        base,
        load: (locale) => import(`./locales/${locale}.json`),
    } satisfies Catalog);
