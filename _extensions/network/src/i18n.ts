import { extensionI18n } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import base from "./locales/en.json";
import { manifest } from "./manifest.js";
export const { messages, t } = extensionI18n(extensionIdOf(manifest), base, (locale) => import(`./locales/${locale}.json`));
