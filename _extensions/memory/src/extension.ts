import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-memory activation: bind the host handle, then register the always-present "Memory" rail view. The agent
 * accumulates memory notes as it works, so the view detects unconditionally — an empty state simply says
 * nothing has been remembered yet (no repo/capability evidence needed, same rationale as logs). */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `memory`,
            label: `Memory`,
            surface: `rail`,
            detect: () => [{ key: `memory`, title: `Memory`, icon: `sparkles` }],
            view: async () => (await import(`./MemoryView.vue`)).default,
        }),
    );
};
