import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { Capability, WebExtSessionImport } from "@intentic/sandbox-contract";
import { acquireProfileLock, isProfileOpen, markConnected, profileOwner, releaseProfileLock, sessionDir } from "../browser/session-store.js";

/* THE ONE PLACE A SESSION CROSSES FROM THE PERSON'S BROWSER INTO THE SANDBOX'S.
 *
 * The owner clicks "Connect this site" in their extension; the extension POSTs that site's cookies straight to
 * this daemon (never through the socket, never as a tool result — webext-protocol.ts's webextSessionUrl says
 * why), and this writes them into the Chromium profile of a `browser` capability that already exists.
 *
 * WHY WRITE THEM WITH CHROMIUM RATHER THAN INTO ITS FILES. A profile's cookie jar is a SQLite database whose
 * values are encrypted with a key the OS keyring holds; a writer that edited it by hand would be reimplementing
 * Chromium's own storage format, on the wrong side of a version bump, for a feature whose failure mode is a
 * corrupted profile. So the profile's own browser does the writing: launch it on that directory, hand it the
 * cookies through CDP, close it. Headless is right here and nowhere else in this daemon — nothing is browsed,
 * no site sees this window, and it is the fastest way to open and shut a profile.
 *
 * WHAT THIS DOES NOT DO is decide whether it was allowed. That switch (`cookies` on the browser's capability
 * card) is enforced in the extension, with the rest of them, because a grant about somebody's browser belongs
 * where their browser is — and because a second implementation here is a second thing to drift. What this door
 * checks is what only it can: that the caller holds an enrollment, and that the account it names exists. */

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

export interface SessionImportResult {
    readonly ok: boolean;
    // The sentence the extension shows the owner and the agent reads back. Never carries a cookie name or a
    // value: the whole point of this door is that neither the model nor a log ever sees one.
    readonly message: string;
}

// Chromium's "session cookie" sentinel. A cookie with no expiry dies with the browser that holds it, which for
// an imported session means the next time the agent's browser restarts — worth knowing, not worth failing over.
const SESSION_COOKIE = -1;

export const importBrowserSession = async (
    payload: WebExtSessionImport,
    context: {
        readonly workspaceRoot: string;
        readonly capabilities: readonly Capability[];
    },
): Promise<SessionImportResult> => {
    const account = context.capabilities.find((entry) => entry.id === payload.account && entry.kind === "browser");
    if (account === undefined) {
        return {
            ok: false,
            message: `No connected-browser account called "${payload.account}" in this sandbox. Add the site as a browser account first, then hand it a session.`,
        };
    }
    const owner = profileOwner(account);
    /* Chromium locks a --user-data-dir, so this cannot run while the owner's own profile window or a turn's
     * browser tools hold it. Refusing with the reason beats waiting: the person is standing in front of the
     * extension, and "close the window and click again" is an instruction they can act on in two seconds. */
    if (isProfileOpen(owner) || !acquireProfileLock(owner)) {
        return { ok: false, message: `The sandbox's browser for "${payload.account}" is open right now. Close it and hand the session over again.` };
    }
    try {
        const { chromium } = await import("playwright").catch(() => ({ chromium: undefined }));
        if (chromium === undefined || !existsSync(chromium.executablePath())) {
            return {
                ok: false,
                message: `This sandbox has no browser installed yet: add the browser feature pack and rebuild, then hand the session over again.`,
            };
        }
        const dir = sessionDir(context.workspaceRoot, owner);
        await mkdir(dir, { recursive: true });
        const cookies: ChromiumCookie[] = payload.cookies.map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires ?? SESSION_COOKIE,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite,
        }));
        const browser = await chromium.launchPersistentContext(dir, { headless: true, executablePath: chromium.executablePath() });
        try {
            await browser.addCookies(cookies);
        } finally {
            // Closing is what FLUSHES them: Chromium writes its cookie store on shutdown, so a context left
            // open would leave a profile that looks imported and is not.
            await browser.close();
        }
        // The account counts as connected from here: the sandbox's browser can now open that site as them,
        // which is exactly what the marker means everywhere else (browser/session-store.ts).
        await markConnected(context.workspaceRoot, payload.account);
        return {
            ok: true,
            message: `Handed ${payload.cookies.length} cookie${payload.cookies.length === 1 ? "" : "s"} for ${payload.origin} to "${payload.account}". The sandbox's own browser is signed in there now.`,
        };
    } catch (error) {
        // The error's own text, never the payload: a failure here must not become the one log line that holds
        // a session.
        return {
            ok: false,
            message: `Could not write the session into "${payload.account}": ${error instanceof Error ? error.message : String(error)}`,
        };
    } finally {
        releaseProfileLock(owner);
    }
};
