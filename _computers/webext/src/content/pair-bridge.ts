import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE } from "@intentic/sandbox-contract/webext-links";

/* THE ONLY CONTENT SCRIPT THIS EXTENSION DECLARES, and it runs on exactly one family of sites: the sandbox's
 * own. Its entire job is to save somebody a copy-paste.
 *
 * When a person clicks Connect on a browser's capability card, that page posts its pairing code on its own
 * window. This picks it up and hands it to the service worker, which parks it; the popup then shows "a sandbox
 * is offering to connect" with one button. It answers the page so the card can say "your extension has it".
 *
 * WHY THE POPUP STILL HAS TO CLICK. Redeeming a pairing means a `fetch` to the sandbox, which an extension may
 * only make with a host permission for it, which Chrome only grants from a user's own click in an extension
 * page. That constraint is a feature: a web page — even ours — must not be able to connect somebody's browser
 * to a sandbox without them touching the extension.
 *
 * WHY A WINDOW MESSAGE rather than `chrome.runtime.sendMessage` from the page: that route needs the extension's
 * store id compiled into the web app, which does not exist until a listing is approved, differs for an unlisted
 * build, and would leave a locally-loaded extension unpairable. See webext-protocol.ts. */

window.addEventListener("message", (event: MessageEvent) => {
    // Same-window only: `event.source !== window` is a frame or an opener talking, and this must not be
    // reachable from an iframe a sandbox page happens to embed.
    if (event.source !== window || event.origin !== window.location.origin) {
        return;
    }
    const payload = (event.data ?? {}) as { type?: unknown; code?: unknown };
    if (payload.type !== WEBEXT_PAIR_MESSAGE || typeof payload.code !== "string") {
        return;
    }
    const code = payload.code;
    void chrome.runtime.sendMessage({ type: "offer", code }).then(() => {
        // Tells the page an extension is installed and has the code. Not that it is paired: only the person
        // can finish that, in the popup.
        window.postMessage({ type: WEBEXT_PAIRED_MESSAGE }, window.location.origin);
    });
});
