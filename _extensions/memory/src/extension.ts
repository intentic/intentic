import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-memory activation: bind the host handle, then register the always-present "Memory" view. The agent
 * accumulates memory notes as it works, so the view detects unconditionally, an empty state simply says
 * nothing has been remembered yet (no repo/capability evidence needed, same rationale as logs).
 *
 * A SANDBOX SECTION, NOT A RAIL TILE, the same move logs made, for the same reason. The rail is a column of
 * unlabelled squares aimed at from muscle memory all day, and a tile earns one of those seats by being somewhere
 * you go constantly or by being able to tell you something happened. Memory is neither: it is the agent's
 * notebook, read when you go and ask what it believes, and it has nothing to announce, no badge, ever. A
 * permanent icon that never lights up spends a fixed slot to say nothing, and it spent that slot against the
 * tiles that DO fetch you (a run that failed, a post awaiting approval), which on a laptop is the difference
 * between a rail that fits and a rail that scrolls. What it belongs beside is the agent's own configuration,
 * which is exactly what the sandbox hub already holds. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `memory`,
            label: `Memory`,
            surface: `sandbox`,
            detect: () => [{ key: `memory`, title: `Memory`, icon: `sparkles` }],
            view: async () => (await import(`./MemoryView.vue`)).default,
        }),
    );
};
