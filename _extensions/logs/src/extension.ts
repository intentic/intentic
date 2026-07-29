import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-logs activation: bind the host handle, then register the always-present "Logs" view as a SANDBOX HUB tab
 * (/sandbox/logs). The daemon records terminal captures, intentic runs and its own log unconditionally, so the
 * view detects unconditionally (one activation, no repo/capability evidence needed).
 *
 * Not the rail: these files are read-only forensics ABOUT THE BOX, read on the rare occasion something broke —
 * the same class of object as the hub's Status/Usage/Environment tabs. The rail is for surfaces the user acts
 * from, and a permanently present tile that never carries a badge spends a fixed icon slot to say nothing. The
 * live log surface the failure paths link to is the terminal panel; this is the archive behind it. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `logs`,
            label: `Logs`,
            surface: `sandbox`,
            detect: () => [{ key: `logs`, title: `Logs`, icon: `file` }],
            view: async () => (await import(`./LogsView.vue`)).default,
        }),
    );
};
