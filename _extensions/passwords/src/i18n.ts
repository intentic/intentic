import { extensionIdOf } from "@intentic/extension-manifest";
import { extensionI18n } from "@intentic/extension-ui/i18n";
import base from "./locales/en.json";
import { manifest } from "./manifest.js";

// The specifier stays a literal template so the bundler emits one chunk per language. The desktop app mounts the same
// catalog under the same id (src/app/index.ts `passwordsMessages`), so `t` reads alike in both hosts.
export const PASSWORDS_EXTENSION_ID = extensionIdOf(manifest);
export const { messages, t } = extensionI18n(PASSWORDS_EXTENSION_ID, base, (locale) => import(`./locales/${locale}.json`));
