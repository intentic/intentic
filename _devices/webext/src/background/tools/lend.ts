import { type WebExtCookie, webextLendUrl } from "@intentic/sandbox-contract";
import { askConfirm } from "../../page/driver.js";
import { assertScope, RefusedError, siteOf } from "../policy.js";
import { store } from "../store.js";
import { targetTab } from "./tab-access.js";

/* BORROWING A SANDBOX SESSION INTO THIS BROWSER — the mirror of session.ts, and the answer to the sites that
 * cannot be signed into from anywhere else.
 *
 * The sandbox can show the owner its own browser and let them drive it, and for most things that is enough. It
 * is not enough for a passkey, which is bound to an authenticator the person physically holds; or a hardware
 * second factor, which has to be touched; or an employer's SSO that checks the device; or a bank that
 * fingerprints it. On those, "drive my browser remotely" is not a worse experience than being there — it is an
 * impossible one, and no amount of frame rate fixes it.
 *
 * So the session comes HERE for the length of that step. The person completes it as themselves, on the browser
 * the account was actually enrolled on, and hands the refreshed session back with `connect_site` — the tool
 * that already existed, which is why this is a small file rather than a feature.
 *
 * THE SAME THREE GUARDS AS THE HAND-OVER, pointing the other way:
 *
 *   1. The card's `cookies` switch, off by default, pushed from the sandbox. One switch for both directions
 *      deliberately: it is the switch for "sessions may cross between this browser and the sandbox", and a
 *      person who has thought about one direction has thought about the pair.
 *   2. A confirmation IN THE PAGE, every time, whatever the `confirm` setting says — and it names what is about
 *      to happen in the words that matter: this browser is about to be signed in as that account.
 *   3. The cookies come back on the extension's own HTTPS request and NEVER through the socket, because a
 *      socket answer is an MCP result and an MCP result is something the model reads. What the agent gets back
 *      is a count and a site name.
 *
 * ONE SITE, NEVER A PROFILE. The domain is taken from the tab the person is looking at, so the thing being
 * borrowed is the thing in front of them, and the sandbox's own door scopes the read to it as well.
 */

// The registrable-ish domain: the last two labels, or the host itself when it has fewer. The same rule
// session.ts uses for the hand-over, so the two directions agree about what "this site" means — a pair that
// disagreed would lend a session the hand-back could not find.
const cookieDomain = (host: string): string => {
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
};

/* Write one cookie into THIS browser. `chrome.cookies.set` takes a URL rather than a domain, and what it does
 * with the pair decides whether the cookie ends up host-only or covering subdomains — so the URL is rebuilt
 * from the cookie's own domain and path, and the leading dot (Chrome's marker for "and subdomains") is what
 * selects between them. Getting this wrong produces a browser that holds every cookie and is signed in to
 * nothing, which is the failure the hand-over direction learned first. */
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
            // Only for a cookie that was stored as covering subdomains: passing `domain` for a host-only one
            // would widen it, and widening somebody's session is not this tool's to do.
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
    // A read grant is enough to be on the page; borrowing a session into it is its own decision, taken below by
    // the person rather than derived from the site's mode.
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
        // The daemon's own sentence, which names the fixable thing (no such account, its browser is open, that
        // account is not signed in there).
        throw new RefusedError(answer.message ?? `The sandbox would not lend that session (${response.status}).`);
    }

    const written = (await Promise.all(answer.cookies.map(writeCookie))).filter(Boolean).length;
    if (written === 0) {
        throw new RefusedError(`Chrome refused every cookie of that ${domain} session, so nothing changed in this browser.`);
    }
    /* RELOADED, because a page that is already open is showing the OLD session and nothing about writing a
     * cookie tells it otherwise — the person would be looking at a signed-out page and told it worked. */
    await chrome.tabs.reload(tab.id).catch(() => undefined);
    return `${siteOf(domain)} is now signed in here as "${account}". Finish the step in this browser, then hand the session back with connect_site so the sandbox has the refreshed one.`;
};
