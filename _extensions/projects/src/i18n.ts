import type { ExtensionMessages } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { extensionT } from "@intentic/extension-ui/i18n";
import base from "./locales/en.json";
import { manifest } from "./manifest.js";

// This extension's words. The host mounts them under `ext.${extensionIdOf(manifest)}` and loads the reader's language
// before it calls `activate`, so a contribution's title is never briefly in the wrong one.

/**
 * Re-exported from index.ts as the module's `messages`, which is what the host reads. The specifier below has to
 * stay a literal template: that is what lets the bundler emit one chunk per language instead of one opaque request
 * carrying all of them.
 */
export const messages: ExtensionMessages = {
    base,
    load: (locale) => import(`./locales/${locale}.json`),
};

/** Bound once here rather than in every component; keys are this extension's own (`t("title")`). */
export const t = extensionT(extensionIdOf(manifest));
