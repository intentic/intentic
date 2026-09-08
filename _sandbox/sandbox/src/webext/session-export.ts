import { existsSync } from "node:fs";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, WebExtCookie } from "@intentic/sandbox-contract";
import { acquireProfileLock, isProfileOpen, profileOwner, releaseProfileLock, sessionDir } from "../browser/sessions/session-store.js";

// Where a session crosses from the sandbox's browser to the person's (mirrors session-import.ts): some sites (passkeys,
// hardware 2FA, device-checked SSO) cannot be signed into remotely at all, so the session is lent back to the owner's
// own Chrome.
// The payload leaves on the extension's own HTTPS door with its enrollment token, never as a socket/MCP answer, so
// cookies never reach the model's context; the person confirms in their own page, in the extension, not here.
// `domain` scopes the read to one origin, never the whole profile, so lending one site's session cannot also lend every
// other account the profile holds.

// Playwright's own cookie shape, declared rather than imported, so this module doesn't pull in a package it loads
// dynamically (and may be absent on a core image).
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
    // Shown to the owner and read by the agent; never carries a cookie name or value.
    readonly message: string;
    // Absent on failure and from every log line; only the extension ever reads it.
    readonly cookies?: readonly WebExtCookie[];
}

// Chromium's "session cookie" sentinel, the same one the import writes: no expiry, dies with the browser.
const SESSION_COOKIE = -1;
// A ceiling matching the import's, so a jar that would be refused on the way in is not produced on the way out.
const MAX_COOKIES = 300;

// Whether a cookie belongs to the site being lent: an exact-host match alone can miss a session carried on the parent
// domain. Suffix matching on a label boundary matches Chrome's own `getAll({domain})`.
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
    // Chromium locks the profile dir; refusing beats waiting, since live cookies may not be flushed to disk yet.
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
        // Reads through Chromium rather than parsing the SQLite cookie jar by hand, which is encrypted with an
        // OS-keyring key and would reimplement Chromium's storage format. Headless is used only here: nothing is
        // browsed, no site sees this window.
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
            // A session cookie has no expiry; `expires: undefined` isn't the same to a receiving Chrome as an absent
            // key.
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
