import { type WebExtCookie, webextSessionUrl } from "@intentic/sandbox-contract";
import { askConfirm } from "../../page/driver.js";
import { assertScope, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { targetTab } from "./tab-access.js";

// Hands a site's session to the sandbox: the only place a credential leaves this browser. Gated by the cookies
// scope and a page confirmation every time, regardless of the confirm setting; cookies go to the sandbox over
// HTTPS directly, never back through the tool-result socket the model reads.

// Maps Chrome's sameSite spelling to the wire's; `unspecified` (Chrome's "not stated") maps to Lax, matching how a
// receiving Chromium already treats it.
const sameSite = (value: chrome.cookies.Cookie["sameSite"]): WebExtCookie["sameSite"] =>
    value === "strict" ? "Strict" : value === "no_restriction" ? "None" : "Lax";

// Registrable-ish domain: last two labels, or the host itself if shorter. Not a public-suffix list; worst case
// (co.uk) reads a few extra cookies from an already-signed-in site.
const cookieDomain = (host: string): string => {
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
};

export const connectSite = async (account: string, tabId?: number): Promise<string> => {
    const scopes = await store.scopes();
    assertScope(scopes, "cookies");
    // Being on the page only needs read access; handing over its session is a separate decision, made below.
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
    // expires is omitted, not set to undefined: Chromium treats those two differently for a session cookie.
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
        // Prefers the daemon's own message, which names the fixable problem.
        throw new RefusedError(answer.message ?? `The sandbox refused the session (${response.status}).`);
    }
    return answer.message ?? `Handed the ${siteOf(domain)} session to "${account}".`;
};
