import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";
import { t } from "./i18n.js";

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    if (api.backend.available !== true) {return;}
    bindHost(api);
    context.subscriptions.push(api.views.register({
        id: "network", label: t("title"), surface: "rail",
        detect: () => [{ key: "network", title: t("title"), icon: "globe" }],
        view: async () => (await import("./NetworkView.vue")).default,
    }));
};
