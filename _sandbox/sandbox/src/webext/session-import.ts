import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, WebExtSessionImport } from "@intentic/sandbox-contract";
import { acquireProfileLock, isProfileOpen, markConnected, profileOwner, releaseProfileLock, sessionDir } from "../browser/sessions/session-store.js";

// Where a session crosses from the person's browser into the sandbox's: the extension POSTs cookies straight to this
// daemon (never through the socket or as a tool result) and writes them into an existing browser capability's Chromium
// profile.
// Writes go through Chromium itself, not its files: the cookie jar is a SQLite database encrypted with an OS-keyring
// key, so a hand-edit would reimplement Chromium's storage format across a version bump.
// Whether the caller was allowed is enforced in the extension (the `cookies` switch on the capability card), not
// duplicated here; this door only checks that the enrollment and the account exist.

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

export interface SessionImportResult {
    readonly ok: boolean;
    // Shown to the owner and read by the agent; never carries a cookie name or value.
    readonly message: string;
}

// A no-expiry cookie dies when the agent's browser next restarts; worth knowing, not worth failing over.
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
    // Chromium locks the profile dir; refusing beats waiting, since closing the window is a two-second fix.
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
            // Closing flushes the cookies on shutdown; left open, the profile looks imported but isn't.
            await browser.close();
        }
        // Counts as connected from here on, the same meaning the marker has everywhere else (browser/session-store.ts).
        await markConnected(context.workspaceRoot, payload.account);
        return {
            ok: true,
            message: `Handed ${payload.cookies.length} cookie${payload.cookies.length === 1 ? "" : "s"} for ${payload.origin} to "${payload.account}". The sandbox's own browser is signed in there now.`,
        };
    } catch (error) {
        // The error's own text, never the payload: a failure here must not log a session.
        return {
            ok: false,
            message: `Could not write the session into "${payload.account}": ${errorMessage(error)}`,
        };
    } finally {
        releaseProfileLock(owner);
    }
};
