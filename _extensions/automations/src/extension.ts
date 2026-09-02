import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host";

/* ext-automations activation: bind the host handle, then register the "Automations" rail view.
 *
 * IT DETECTS UNCONDITIONALLY, and that is not the same claim it used to be. Automations are native to every
 * sandbox (there is no capability to enable), so the AREA exists everywhere: this is what makes `/ext/automations`
 * resolve, what puts the row in the mobile menu and the More list, and what gives the palette its "Go to
 * Automations". Whether the rail spends a SEAT on it is a separate question, answered by the app's seat table
 * (core-views/registry.ts): a shelf you author once and leave alone does not hold one of nine seats, so this
 * tile lives in More unless the reader pins it.
 *
 * IT HAS NO BADGE, and it used to. The one thing here that ever needed the owner, a `requireApproval` wake held
 * at the door, is a decision of exactly the shape the Approvals page exists for (a prepared thing, waiting for a
 * yes, then carried out precisely), so that page draws the held wakes and its tile carries the count. Badging
 * here as well would seat a "Set up" shelf for a "Judge" decision and count the same yes twice. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `automations`,
            label: `Automations`,
            surface: `rail`,
            detect: () => [{ key: `automations`, title: `Automations`, icon: `clock` }],
            view: async () => (await import(`./AutomationsView.vue`)).default,
        }),
    );
};
