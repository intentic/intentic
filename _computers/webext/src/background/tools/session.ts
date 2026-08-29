import { type WebExtCookie, webextSessionUrl } from "@intentic/sandbox-contract";
import { askConfirm } from "../../page/driver.js";
import { assertScope, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { targetTab } from "./tab-access.js";

/* HANDING A SITE'S SESSION TO THE SANDBOX — the one place a credential leaves this browser.
 *
 * Everything else this extension does BORROWS the person's session: the page is driven where it already is,
 * signed in, in front of them. This copies one, so that a job can carry on after they shut the laptop. It is
 * the only feature here that survives the browser being closed, and the only one that can outlive the person's
 * attention, which is why it is guarded three times over:
 *
 *   1. The card's `cookies` switch, off by default, pushed from the sandbox.
 *   2. A confirmation IN THE PAGE, every single time, whatever the `confirm` setting says. This is not an
 *      action on a page; it is a copy of somebody's identity, and "never ask me" must not reach it.
 *   3. The payload goes browser → daemon over HTTPS with the extension's own enrollment token, and NEVER back
 *      through the socket as a tool result — because a tool result is something the model reads, and this must
 *      not be. What the agent gets back is a count and a site name.
 *
 * The cookies come from the registrable domain rather than the exact origin: a session on `app.example.com` is
 * routinely carried by a cookie set on `.example.com`, and copying only the exact-origin ones produces a
 * profile that looks signed in and is not. Chrome's `getAll({domain})` matches by domain suffix, which is the
 * behaviour wanted here — and it is why the confirmation says the domain, not the URL. */

// Chrome's sameSite spelling → the wire's. `unspecified` is Chrome's "the site did not say", which every
// browser then treats as Lax; naming it Lax here is what a receiving Chromium would have done anyway.
const sameSite = (value: chrome.cookies.Cookie["sameSite"]): WebExtCookie["sameSite"] =>
    value === "strict" ? "Strict" : value === "no_restriction" ? "None" : "Lax";

// The registrable-ish domain: the last two labels, or the host itself when it has fewer. Not a public-suffix
// list — this decides which cookie jar to READ from a domain the person is already on, and the failure mode of
// getting it slightly wrong (co.uk) is a couple of extra cookies from a site they are signed into anyway.
const cookieDomain = (host: string): string => {
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
};

export const connectSite = async (account: string, tabId?: number): Promise<string> => {
    const scopes = await store.scopes();
    assertScope(scopes, "cookies");
    // A read grant is enough to be ON the page; handing its session over is its own decision, taken below by
    // the person rather than derived from the site's mode.
    const tab = await targetTab("read", tabId);
    const sandbox = await store.sandbox();
    if (sandbox === undefined) {
        throw new RefusedError(`This browser is not paired with a sandbox any more.`);
    }
    const host = new URL(tab.url).hostname;
    const domain = cookieDomain(host);

    const [confirmation] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: askConfirm,
        args: [
            `Hand your ${domain} sign-in to the sandbox account "${account}"? It will then be able to use ${domain} as you, without this browser open.`,
            120_000,
        ],
    });
    if (confirmation?.result !== true) {
        throw new RefusedError(
            `They did not agree to hand over the ${domain} session. Leave it: the work can be done here, in their browser, while they watch.`,
        );
    }

    const jar = await chrome.cookies.getAll({ domain });
    if (jar.length === 0) {
        throw new RefusedError(`There is no ${domain} session in this browser to hand over.`);
    }
    // A session cookie has no expiry to carry, and one written as `expires: undefined` is not the same thing to
    // a receiving Chromium — hence the conditional key rather than a spread.
    const cookies: WebExtCookie[] = jar.slice(0, 300).map((cookie) => {
        const carried: { -readonly [K in keyof WebExtCookie]: WebExtCookie[K] } = {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: sameSite(cookie.sameSite),
        };
        if (!cookie.session && cookie.expirationDate !== undefined) {
            carried.expires = Math.floor(cookie.expirationDate);
        }
        return carried;
    });

    const response = await fetch(webextSessionUrl(sandbox.url), {
        method: "POST",
        headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
        body: JSON.stringify({ account, origin: domain, cookies }),
    });
    const answer = (await response.json().catch(() => ({}))) as { message?: string };
    if (!response.ok) {
        // The daemon's own sentence, which names the fixable thing (no such account, its browser is open).
        throw new RefusedError(answer.message ?? `The sandbox refused the session (${response.status}).`);
    }
    return answer.message ?? `Handed the ${siteOf(domain)} session to "${account}".`;
};
