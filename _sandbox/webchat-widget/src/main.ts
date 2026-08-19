import { FrontDeskElement } from "./element.js";
import { fetchConfig } from "./transport.js";

/* The embed's entry point. One <script> on a customer's page:
 *
 *   <script src="https://sandbox-<id>.<zone>/webchat/widget.js" data-automation="support" defer></script>
 *
 * Everything else is derived: the daemon to talk to is the ORIGIN THIS SCRIPT CAME FROM, which is the one
 * thing a copy-pasted snippet can't get wrong. `data-base` overrides it for a site fronting the sandbox behind
 * its own proxy — the only case where the two legitimately differ. */

const TAG = "intentic-front-desk";

// `document.currentScript` is only valid while the script body is executing, so it is read at module scope
// rather than inside the async boot below. The querySelector is the fallback for a bundler or tag manager that
// re-executes this in a context where currentScript is null.
const ownScript =
    (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>(`script[src*="/webchat/widget.js"]`);

const boot = async (script: HTMLScriptElement): Promise<void> => {
    const automationId = script.dataset["automation"];
    if (automationId === undefined || automationId === "") {
        // The one mistake worth a console line: without it the widget is silently absent and the site owner has
        // nothing to go on. Every other failure surfaces inside the panel, where the visitor can see it.
        console.error(`[intentic] the Front Desk embed needs data-automation="<automation id>"`);
        return;
    }
    const base = (script.dataset["base"] ?? new URL(script.src, window.location.href).origin).replace(/\/$/, "");
    const endpoint = { base, automationId };

    // The config fetch is also the reachability probe: a sandbox that is asleep, an automation that was
    // deleted, or an origin that isn't on the allowlist all land here — and in every one of those cases the
    // right thing is to render NOTHING. A launcher that opens onto an error is worse than no launcher.
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
