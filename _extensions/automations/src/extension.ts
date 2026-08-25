import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { automationsBadge, startApprovalAttention } from "./attention";
import { approvalsQuery } from "./approvalsQuery";
import { bindHost } from "./host";

/* ext-automations activation: bind the host handle, start the badge's background poll, then register the
 * "Automations" rail view.
 *
 * IT DETECTS UNCONDITIONALLY, and that is not the same claim it used to be. Automations are native to every
 * sandbox (there is no capability to enable), so the AREA exists everywhere: this is what makes `/ext/automations`
 * resolve, what puts the row in the mobile menu and the More list, and what gives the palette its "Go to
 * Automations". Whether the rail spends a SEAT on it is a separate question, answered by the app's seat table
 * (core-views/registry.ts) from the badge below: a shelf you author once and leave alone does not hold one of
 * nine seats while it has nothing to say.
 *
 * Which is why this extension grew a badge at all. See attention.ts: a `requireApproval` wake is the one thing
 * here that stops dead until the owner acts, and a surface that can need you must be able to say so. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registration, so the tile can be seated on its first render rather than five minutes later.
    context.subscriptions.push(startApprovalAttention());
    context.subscriptions.push(
        api.views.register({
            id: `automations`,
            label: `Automations`,
            surface: `rail`,
            detect: () => [{ key: `automations`, title: `Automations`, icon: `clock` }],
            badge: () => automationsBadge(),
            /* The queue the page opens on, and the one read worth asking for early: somebody arriving here has
             * almost always been sent by the badge, so the held wakes are the whole reason for the visit. It is
             * also the entry the badge itself fills, so this costs nothing the tile was not already reading. */
            warm: () => [approvalsQuery()],
            view: async () => (await import(`./AutomationsView.vue`)).default,
        }),
    );
};
