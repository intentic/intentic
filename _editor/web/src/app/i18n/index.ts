import { type Catalog, registerCatalog, startI18n } from "@intentic/ui/i18n";
import base from "./locales/en.json";

type AppMessages = typeof base;

// `en` is the schema as well as the fallback: this is the shape every other language is reshaped to, and the tree
// `t` resolves a key against. @intentic/ui augments the same interface with its own `ui` slice; TypeScript merges
// the two. What it does NOT do is refuse a key that is not in here — vue-i18n's `t` takes any string, whatever the
// schema says — so the gate on a typo is `_tools/checks/i18n-keys.mjs`, not the compiler.
//
// One line per top-level section, rather than `extends AppMessages`, because an empty interface body is banned.
// A section is one feature area: `src/features/<area>` keys under `<area>`, core-views under `views`, `src/shell`
// under `shell`, `src/components` under `common`. Every top-level section is listed, and `i18nSections.test.ts` fails
// on one that is not.
//
// Where a word lives:
// - `ui.action.*` (the kit's): a verb any surface's control can carry (Cancel, Restore, Show less); `ui.status.*` the
//   progress words (Loading…, Working…).
// - `shared.*`: a NOUN (or a state a thing is in) that means the same in every feature that says it: the sections'
//   own names, Agent, Model, Running. English alone is not a reason to share: "Access" the sandbox section and
//   "Access" a capability's grant are two keys. `_tools/checks/i18n-shared.mjs` refuses what is never a noun phrase.
// - `<area>.words.*`: a word several of one feature's components say; a phrase another feature borrows stays with the
//   feature it belongs to.
// - `<area>.<component>.*`: everything else.
declare module "vue-i18n" {
    interface DefineLocaleMessage {
        readonly agents: AppMessages["agents"];
        readonly app: AppMessages["app"];
        readonly auth: AppMessages["auth"];
        readonly browsers: AppMessages["browsers"];
        readonly capabilities: AppMessages["capabilities"];
        readonly chat: AppMessages["chat"];
        readonly common: AppMessages["common"];
        readonly connect: AppMessages["connect"];
        readonly "extension-host": AppMessages["extension-host"];
        readonly extensions: AppMessages["extensions"];
        readonly preview: AppMessages["preview"];
        readonly router: AppMessages["router"];
        readonly sandbox: AppMessages["sandbox"];
        readonly settings: AppMessages["settings"];
        readonly setup: AppMessages["setup"];
        readonly shared: AppMessages["shared"];
        readonly shell: AppMessages["shell"];
        readonly terminal: AppMessages["terminal"];
        readonly views: AppMessages["views"];
        readonly workspace: AppMessages["workspace"];
    }
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
