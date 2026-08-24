import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-activity activation: bind the host handle, then register the "Activity" view. The feed is part of the
 * sandbox for every role that may read it; activation must not depend on the privileged capability inventory,
 * or a member can read /activity but has no route to the view.
 *
 * A SANDBOX SECTION, NOT A RAIL TILE, the same move logs made, and Activity is the closer relative of the two:
 * it is the record of what reached this box and what it did about it, which is the sandbox hub's own subject.
 * It never badges and never will, because what it holds is a LEVEL and not an edge, a feed that is always
 * moving would light the rail permanently, and a tile that is always lit says nothing. The things in it that
 * genuinely want you are already surfaced where they can be acted on: a failed automation run is on its
 * automation's row, and a wake held for approval is a card on the fleet board. This is where you come to read
 * the whole record afterwards, on your own initiative, which is a hub section's job, not a rail seat's. */

export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `activity`,
            label: `Activity`,
            surface: `sandbox`,
            detect: () => [{ key: `activity`, title: `Activity`, icon: `wave-pulse` }],
            view: async () => (await import(`./ActivityView.vue`)).default,
        }),
    );
};
