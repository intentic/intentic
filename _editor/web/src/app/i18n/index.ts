import { registerCatalog, startI18n } from "@intentic/ui/i18n";
import base from "./locales/en.json";

type AppMessages = typeof base;

// `en` is the schema as well as the fallback: every key `$t` will accept comes from this file, so a typo is a build
// error rather than a blank label a reader finds. @intentic/ui augments the same interface with its own `ui` slice;
// TypeScript merges the two.
//
// One line per top-level section, rather than `extends AppMessages`, because an empty interface body is banned. A
// section added to en.json and forgotten here has a short feedback loop: its keys simply will not type-check.
declare module "vue-i18n" {
    interface DefineLocaleMessage {
        readonly settings: AppMessages["settings"];
    }
}

/**
 * Registers the editor's own words and brings the reader's language on screen.
 *
 * AWAIT THIS BEFORE MOUNTING. That await is the whole no-flicker guarantee on a cold load: nothing paints until the
 * messages for the right language are in hand, so no reader ever watches English swap to Polish. It costs a reader
 * already on English nothing, since `en` is compiled in.
 *
 * The editor's catalog is the one with no namespace — it sits at the root of the message tree, so a key reads
 * `settings.appearance.look.theme` and not `app.settings.…`. Everything else that contributes messages
 * (@intentic/ui, every extension) is namespaced away from it, so nothing can collide here.
 */
export const startAppI18n = async (): Promise<void> => {
    // The specifier has to stay a literal template: that is what lets the bundler enumerate `./locales/*.json` and
    // emit ONE CHUNK PER LANGUAGE, none of which is in the initial download. Build the path in a variable and it
    // becomes one opaque request the bundler cannot split.
    await registerCatalog({ base, load: (locale) => import(`./locales/${locale}.json`) });
    await startI18n();
};
