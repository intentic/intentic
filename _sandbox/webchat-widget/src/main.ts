import { embedEndpointOf, embedScript } from "@intentic/sandbox-contract/embed";
import { FrontDeskElement } from "./element.js";
import { fetchConfig } from "./transport.js";

// Embed entry point, loaded via a single <script data-automation> tag on the customer's page; origin comes from the
// script's own src, `data-base` overrides it behind a proxy.

const TAG = "intentic-front-desk";

// Read at module scope, while this script's body is still executing.
const ownScript = embedScript("/webchat/widget.js");

const boot = async (script: HTMLScriptElement): Promise<void> => {
    const endpoint = embedEndpointOf(script);
    if (endpoint === undefined) {
        // Only failure logged to console; every other failure surfaces inside the panel instead.
        console.error(`[intentic] the Front Desk embed needs data-automation="<automation id>"`);
        return;
    }

    // Doubles as the reachability probe: a sleeping sandbox or disallowed origin lands here, rendering nothing.
    const config = await fetchConfig(endpoint).catch((error: unknown) => {
        console.error(`[intentic] Front Desk is unavailable:`, error);
        return undefined;
    });
    if (config === undefined) {
        return;
    }

    if (customElements.get(TAG) === undefined) {
        customElements.define(TAG, FrontDeskElement);
    }
    const element = document.createElement(TAG) as FrontDeskElement;
    element.configure(config, endpoint);
    document.body.append(element);
};

if (ownScript === null) {
    console.error(`[intentic] the Front Desk embed could not find its own <script> tag`);
} else {
    void boot(ownScript);
}
