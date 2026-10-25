import { type Catalog, registerCatalog, startI18n } from "@intentic/ui/i18n";
import base from "./locales/en.json";

type AppMessages = typeof base;

// en.json defines fallback and the full message schema, merged with the kit's ui slice; i18n-keys.mjs catches typos because t accepts strings.
// Feature keys live under <area>, core views under views, shell under shell, and common components under common.
// ui.action/status owns shared verbs/progress; shared.* holds cross-feature nouns/states only, enforced by i18n-shared.mjs.
// Keep feature vocabulary in <area>.words and component copy in <area>.<component>; identical English alone does not justify sharing.
declare module "vue-i18n" {
    // oxlint-disable-next-line typescript/no-empty-object-type -- module augmentation merges only into an interface, so en.json's whole tree enters by `extends`
    interface DefineLocaleMessage extends AppMessages {}
}

/**
 * The editor's own words: the one catalog with no namespace, sitting at the root of the message tree, so a key reads
 * `settings.appearance.look.theme` and not `app.settings.…`. Everything else that contributes messages
 * (@intentic/ui, every extension) is namespaced away from it, so nothing can collide here.
 *
 * Exported rather than registered inline because the app's boot is not the only thing that needs it: a component test
 * mounts without a boot, and a component whose catalog nobody registered renders its keys.
 */
export const appCatalog: Catalog = {
    base,
    // The specifier has to stay a literal template: that is what lets the bundler enumerate `./locales/*.json` and
    // emit ONE CHUNK PER LANGUAGE, none of which is in the initial download. Build the path in a variable and it
    // becomes one opaque request the bundler cannot split.
    load: (locale) => import(`./locales/${locale}.json`),
};

/**
 * Registers the editor's own words and brings the reader's language on screen.
 *
 * AWAIT THIS BEFORE MOUNTING. That await is the whole no-flicker guarantee on a cold load: nothing paints until the
 * messages for the right language are in hand, so no reader ever watches English swap to Polish. It costs a reader
 * already on English nothing, since `en` is compiled in.
 */
export const startAppI18n = async (): Promise<void> => {
    await registerCatalog(appCatalog);
    await startI18n();
};
