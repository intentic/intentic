import { registerCatalog } from "./i18n.js";
import base from "./locales/en.json";

// The whole i18n surface, and the only import path for it. Importing it also registers the design system's own
// words — the ones it draws without being told, like a confirm dialog's Cancel or a copy button's Copied — so a
// surface that mounts `@intentic/ui` without being the editor (the desktop shell, the shared conversation page)
// still gets them.
//
// The specifier below has to stay a literal template: that is what lets the bundler enumerate `./locales/*.json`
// and emit ONE CHUNK PER LANGUAGE. Build the path in a variable and it becomes one opaque request the bundler
// cannot split, which is how every language ends up in the initial download.
void registerCatalog({
    namespace: `ui`,
    base,
    load: (locale) => import(`./locales/${locale}.json`),
});

// The shape of the `en` file, as the tree a key resolves against. Every package that registers a catalog adds its
// slice to this same interface; TypeScript merges the declarations, so the app's own augmentation and this one
// compose rather than compete. It is NOT a check on the key: vue-i18n's `t` takes any string, so a typo is a dotted
// path in front of a reader until `_tools/checks/i18n-keys.mjs` refuses it.
declare module "vue-i18n" {
    interface DefineLocaleMessage {
        readonly ui: typeof base;
    }
}

export {
    activeLocale,
    BASE_LOCALE,
    type Catalog,
    installI18n,
    isLocale,
    type Locale,
    LOCALE_CODES,
    LOCALE_KEY,
    LOCALES,
    type LooseT,
    type MessageTree,
    negotiate,
    registerCatalog,
    setLocale,
    startI18n,
    t,
    type TypedT,
    useT,
} from "./i18n.js";
