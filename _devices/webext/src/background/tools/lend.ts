import { type WebExtCookie, webextLendUrl } from "@intentic/sandbox-contract";
import { askConfirm } from "../../page/driver.js";
import { assertScope, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { targetTab } from "./tab-access.js";

// Borrows a sandbox session into this browser (session.ts's hand-over, reversed), for logins impossible to drive
// remotely: passkeys, hardware 2FA, device-checking SSO. The person completes the step here and hands the
// refreshed session back via connect_site. Same three guards as the hand-over:
// - the `cookies` switch, shared by both directions
// - an in-page confirmation every time, regardless of the `confirm` setting
// - cookies return over this extension's own HTTPS request, never the socket; the agent only sees a count and a site
//   name

// The registrable-ish domain: last two labels, or the host itself with fewer. Same rule session.ts uses for the
// hand-over, so both directions agree on what "this site" means.
const cookieDomain = (host: string): string => {
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
};

// Writes one cookie into this browser. `chrome.cookies.set` takes a URL, not a domain; the leading dot (Chrome's
// "and subdomains" marker) picks host-only vs. subdomain-covering when rebuilding it.
const writeCookie = async (cookie: WebExtCookie): Promise<boolean> => {
    const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
    const written = await chrome.cookies
        .set({
            url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`,
            name: cookie.name,
            value: cookie.value,
            path: cookie.path,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite === "Strict" ? "strict" : cookie.sameSite === "None" ? "no_restriction" : "lax",
            // Only for a cookie stored covering subdomains; passing `domain` for a host-only one would widen the
            // session.
            ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
            // Absent expiry means a session cookie, which is what it was in the sandbox and what it should stay.
            ...(cookie.expires === undefined ? {} : { expirationDate: cookie.expires }),
        })
        .catch(() => undefined);
    return written !== undefined && written !== null;
};

export const lendSite = async (account: string, tabId?: number): Promise<string> => {
    const scopes = await store.scopes();
    assertScope(scopes, "cookies");
    // A read grant is enough to be on the page; borrowing a session is its own decision, taken below by the person,
    // not derived from the site's mode.
    const tab = await targetTab("read", tabId);
    const sandbox = await store.sandbox();
    if (sandbox === undefined) {
        throw new RefusedError(`This browser is not paired with a sandbox any more.`);
    }
    const domain = cookieDomain(new URL(tab.url).hostname);

    const [confirmation] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: askConfirm,
        args: [
            `Sign this browser in to ${domain} as the sandbox account "${account}"? It will replace your current ${domain} sign-in here until you sign out.`,
            120_000,
        ],
    });
    if (confirmation?.result !== true) {
        throw new RefusedError(`They did not agree to borrow the ${domain} session. Leave it: work the site from the sandbox's own browser instead.`);
    }

    const response = await fetch(webextLendUrl(sandbox.url), {
        method: "POST",
        headers: { authorization: `Bearer ${sandbox.token}`, "content-type": "application/json" },
        body: JSON.stringify({ account, domain }),
    });
    const answer = (await response.json().catch(() => ({}))) as { message?: string; cookies?: WebExtCookie[] };
    if (!response.ok || answer.cookies === undefined) {
        // The daemon's own sentence names the fixable thing: no such account, its browser is open, or that account
        // isn't
        // signed in there.
        throw new RefusedError(answer.message ?? `The sandbox would not lend that session (${response.status}).`);
    }

    const written = (await Promise.all(answer.cookies.map(writeCookie))).filter(Boolean).length;
    if (written === 0) {
        throw new RefusedError(`Chrome refused every cookie of that ${domain} session, so nothing changed in this browser.`);
    }
    // Reloaded, since an already-open page still shows the old session; without this, the person sees a stale page
    // while being told it worked.
    await chrome.tabs.reload(tab.id).catch(() => undefined);
    return `${siteOf(domain)} is now signed in here as "${account}". Finish the step in this browser, then hand the session back with connect_site so the sandbox has the refreshed one.`;
};
