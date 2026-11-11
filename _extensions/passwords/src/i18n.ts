import { extensionI18n } from "@intentic/extension-ui/i18n";
import base from "./locales/en.json";

// The app's catalog, under the id it has always been registered by, so a reader's words carry over. The specifier stays
// a literal template so the bundler emits one chunk per language. The desktop app mounts it (src/app/index.ts
// `registerPasswordsMessages`) before it draws the app.
export const PASSWORDS_EXTENSION_ID = `intentic.passwords`;
export const { messages, t } = extensionI18n(PASSWORDS_EXTENSION_ID, base, (locale) => import(`./locales/${locale}.json`));
