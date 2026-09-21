import { extensionIdOf } from "@intentic/extension-manifest";
import { extensionI18n } from "@intentic/extension-ui/i18n";
import base from "./locales/en.json";
import { manifest } from "./manifest.js";

// This extension's words, re-exported from index.ts as the module's `messages`, which is what the host reads: it
// mounts them under `ext.${extensionIdOf(manifest)}` and loads the reader's language before it calls `activate`, so
// a contribution's title is never briefly in the wrong one. The specifier below has to stay a literal template —
// that is what lets the bundler emit one chunk per language instead of one opaque request carrying all of them.
export const { messages, t } = extensionI18n(extensionIdOf(manifest), base, (locale) => import(`./locales/${locale}.json`));
