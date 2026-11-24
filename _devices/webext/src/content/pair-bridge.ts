import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE } from "@intentic/sandbox-contract/webext-links";
import { fromAppWindow } from "./app-origins.js";

// Only content script this extension declares, running solely on the editor's own origin (app-origins.ts); relays a
// pairing code the page posts to its own window, to the service worker. The popup itself must still get the click:
// redeeming a pairing needs a host-permission fetch, which Chrome grants only from a user gesture in an extension page.

window.addEventListener("message", (event: MessageEvent) => {
    // Same-window and app origin only: never an iframe or opener the page might embed, nor a page the manifest's match
    // let through by mistake.
    if (!fromAppWindow(event, { window, origin: window.location.origin })) {
        return;
    }
    const payload = (event.data ?? {}) as { type?: unknown; code?: unknown };
    if (payload.type !== WEBEXT_PAIR_MESSAGE || typeof payload.code !== "string") {
        return;
    }
    const code = payload.code;
    void chrome.runtime.sendMessage({ type: "offer", code }).then(() => {
        // Tells the page an extension has the code; pairing itself is finished only by the person, in the popup.
        window.postMessage({ type: WEBEXT_PAIRED_MESSAGE }, window.location.origin);
    });
});
