import { existsSync } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, WebExtCookie } from "@intentic/sandbox-contract";
import { acquireProfileLock, isProfileOpen, profileOwner, releaseProfileLock, sessionDir } from "../browser/session-store.js";

/* THE ONE PLACE A SESSION CROSSES FROM THE SANDBOX'S BROWSER INTO THE PERSON'S — the mirror of
 * session-import.ts, and the answer to the thing no amount of streaming quality can fix.
 *
 * WHY THIS EXISTS AT ALL, when the owner can already watch the sandbox's browser and take its wheel. Because
 * some sites cannot be signed into from somewhere else, however good the picture is. A passkey is bound to an
 * authenticator the person physically has. A hardware second factor has to be touched. An employer's SSO checks
 * the device. A bank fingerprints it. For those, "drive my browser remotely" is not a worse experience than
 * being there — it is an impossible one, and the honest move is to stop pretending and hand the session back to
 * the browser the account was actually enrolled on.
 *
 * So: the agent gets stuck on such a site, the owner says "let me do it", and this lends that site's session to
 * their own Chrome for as long as it takes. They finish the step as themselves, then hand it back with the
 * `connect_site` tool that already existed — which is why this is a small file rather than a feature. The
 * return leg was already built; only the outbound one was missing.
 *
 * WHAT IS AND IS NOT GUARDED HERE, following session-import.ts exactly:
 *   - The payload leaves on the extension's OWN HTTPS door with its enrollment token, never as an answer on the
 *     socket — socket answers are MCP results and MCP results land in the model's context. The agent's tool
 *     call gets back a count and a site name; the cookies it never sees.
 *   - The person confirms IN THEIR OWN PAGE, every time, in the extension. That gate is not here for the same
 *     reason the import's is not: a decision about somebody's browser belongs where their browser is, and a
 *     second copy of it here is a second thing to drift.
 *   - What this door checks is what only it can: that the caller holds an enrollment, that the account exists,
 *     and that its profile is not open right now.
 *
 * ONE ORIGIN, NEVER THE PROFILE. `domain` scopes the read, so lending a Jira session cannot also lend the
 * bank. A profile holds every account its owner ever connected, and handing all of it over because the agent
 * got stuck on one site would be the kind of over-broad grant that is invisible until it matters.
 */

// Playwright's own cookie shape. Declared rather than imported so this module does not pull the type surface of
// a package it loads dynamically (and that may be absent altogether on a core image).
interface ChromiumCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
}

export interface SessionExportResult {
    readonly ok: boolean;
    // The sentence the extension shows the owner and the agent reads back. Never carries a cookie name or a
    // value: the whole point of this door is that neither the model nor a log ever sees one.
    readonly message: string;
    // Absent on failure, and absent from every log line. Only the extension ever reads this.
    readonly cookies?: readonly WebExtCookie[];
}

// Chromium's "session cookie" sentinel, the same one the import writes: no expiry, dies with the browser.
const SESSION_COOKIE = -1;
// A ceiling matching the import's, so a jar that would be refused on the way in is not produced on the way out.
const MAX_COOKIES = 300;

/* Does this cookie belong to the site being lent. Chrome stores a domain either bare ("github.com") or with a
 * leading dot for a cookie that covers subdomains (".github.com"), and a session on `app.example.com` is
 * routinely carried by one set on `.example.com` — so a match on the exact host alone produces a hand-over that
 * looks complete and signs into nothing. Suffix matching on a label boundary is what Chrome's own
 * `getAll({domain})` does, which is the behaviour the import was written against. */
const belongsTo = (cookieDomain: string, domain: string): boolean => {
    const bare = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
    return bare === domain || bare.endsWith(`.${domain}`) || domain.endsWith(`.${bare}`);
};

export const exportBrowserSession = async (
    request: { readonly account: string; readonly domain: string },
    context: {
        readonly workspaceRoot: string;
        readonly capabilities: readonly Capability[];
    },
): Promise<SessionExportResult> => {
    const account = context.capabilities.find((entry) => entry.id === request.account && entry.kind === "browser");
    if (account === undefined) {
        return {
            ok: false,
            message: `No connected-browser account called "${request.account}" in this sandbox.`,
        };
    }
    const owner = profileOwner(account);
    /* Chromium locks a --user-data-dir, so this cannot run while the owner's own window or a turn's browser
     * tools hold it. Refusing with the reason beats waiting: the person is standing in front of the extension,
     * and "close the window and try again" is an instruction they can act on in two seconds. It is also the
     * honest answer rather than a nicety — a profile being written by a live Chromium has cookies in memory
     * that are not on disk yet, so a read taken now would hand over a session one refresh out of date. */
    if (isProfileOpen(owner) || !acquireProfileLock(owner)) {
        return { ok: false, message: `The sandbox's browser for "${request.account}" is open right now. Close it and try again.` };
    }
    try {
        const { chromium } = await import("playwright").catch(() => ({ chromium: undefined }));
        if (chromium === undefined || !existsSync(chromium.executablePath())) {
            return { ok: false, message: `This sandbox has no browser installed yet, so there is no session in it to lend.` };
        }
        const dir = sessionDir(context.workspaceRoot, owner);
        if (!existsSync(dir)) {
            return { ok: false, message: `"${request.account}" has no browser profile yet: sign it in first.` };
        }
        /* READ THROUGH CHROMIUM, for the reason the import WRITES through it: a profile's cookie jar is a SQLite
         * database whose values are encrypted with a key the OS keyring holds, and a reader that parsed it by
         * hand would be reimplementing Chromium's storage format on the wrong side of a version bump. Headless
         * is right here and nowhere else in this daemon — nothing is browsed and no site sees this window. */
        const browser = await chromium.launchPersistentContext(dir, { headless: true, executablePath: chromium.executablePath() });
        let jar: ChromiumCookie[];
        try {
            jar = (await browser.cookies()) as ChromiumCookie[];
        } finally {
            await browser.close();
        }
        const matched = jar.filter((cookie) => belongsTo(cookie.domain, request.domain)).slice(0, MAX_COOKIES);
        if (matched.length === 0) {
            return { ok: false, message: `"${request.account}" is not signed in to ${request.domain}: there is no session there to lend.` };
        }
        const cookies: WebExtCookie[] = matched.map((cookie) => {
            const carried: { -readonly [K in keyof WebExtCookie]: WebExtCookie[K] } = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                httpOnly: cookie.httpOnly,
                secure: cookie.secure,
                sameSite: cookie.sameSite,
            };
            // A session cookie has no expiry to carry, and one written as `expires: undefined` is not the same
            // thing to a receiving Chrome — hence the conditional key rather than a spread.
            if (cookie.expires !== undefined && cookie.expires !== SESSION_COOKIE) {
                carried.expires = Math.floor(cookie.expires);
            }
            return carried;
        });
        return {
            ok: true,
            message: `Lent the ${request.domain} session from "${request.account}" to this browser.`,
            cookies,
        };
    } catch (error) {
        // The error's own text, never the jar: a failure here must not become the one log line that holds a
        // session.
        return {
            ok: false,
            message: `Could not read the session out of "${request.account}": ${errorMessage(error)}`,
        };
    } finally {
        releaseProfileLock(owner);
    }
};
