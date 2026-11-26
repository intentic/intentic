import { extensionIdOf } from "@intentic/extension-manifest";
import { extensionI18n } from "@intentic/extension-ui/i18n";
import base from "./locales/en.json";
import { manifest } from "./manifest.js";

// The specifier stays a literal template so the bundler emits one chunk per language.
export const { messages, t } = extensionI18n(extensionIdOf(manifest), base, (locale) => import(`./locales/${locale}.json`));
