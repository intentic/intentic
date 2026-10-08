import type { Page } from "playwright";
import type { OpenBrowserResult } from "@intentic/sandbox-contract";
import { chromiumWindowArgs, ensureDisplay, releaseDisplay } from "../cast/display.js";
import { adoptBrowserSession, browserSessionBlankPage, browserSessionNewTab, browserSessionRunning } from "./browser-sessions.js";
import { browserFingerprint } from "./fingerprint.js";
import { launchOwnerBrowser } from "./owner-browser.js";
import { launchSessionDir } from "./session-store.js";
import { stealthInit } from "./stealth.js";

// The person's own browser window: the one the browser view opens when they type an address with nothing open, or press
// + in a window that is not theirs to drive. Not an agent's: no tool call starts it, no turn owns it, and the idle
// reaper leaves it alone (browser-sessions.ts). It is started the way an account's sign-in window is (owner-browser.ts:
// a plain Chromium, attached afterwards) on a display of its own, so its picture is real video and its clicks are real
// input, with a persistent profile, so what they sign into stays signed in the next time they open it.

// The display key and the profile's directory name. A leading underscore is a name no connected account takes, so the
// person's window never shares a display or a profile with one.
export const OWN_BROWSER_SERVER = "_own";
// One window, one name: the view's address for it survives closing and reopening it.
export const OWN_BROWSER_SESSION = "browser-own";

interface OwnBrowserDeps {
    readonly root: string;
    readonly warn: (fields: Record<string, unknown>, message: string) => void;
}

// One start at a time: a second tab asked for while the window is still coming up waits for it rather than racing a
// second Chromium onto the same profile.
let starting: Promise<void> | undefined;

const start = async (deps: OwnBrowserDeps): Promise<void> => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        throw new Error("the browser is not installed: rebuild the sandbox (Environment card) first");
    }
    const display = await ensureDisplay(OWN_BROWSER_SERVER);
    try {
        // Leaves by the sandbox's own address, so it claims the sandbox's own place: no exit to agree with.
        const fingerprint = await browserFingerprint(deps.root, OWN_BROWSER_SERVER);
        const owned = await launchOwnerBrowser(playwright, {
            executablePath: playwright.chromium.executablePath(),
            userDataDir: await launchSessionDir(deps.root, OWN_BROWSER_SERVER),
            display: display.name,
            fingerprint,
            windowArgs: chromiumWindowArgs(display),
        });
        // Patches residual server tells before the first navigation, as on every other window a person sees.
        await owned.context.addInitScript(stealthInit(fingerprint));
        adoptBrowserSession({ name: OWN_BROWSER_SESSION, server: OWN_BROWSER_SERVER, context: owned.context, shutdown: owned.close });
    } catch (err) {
        // Nothing is on the display now; a later open starts a fresh one.
        releaseDisplay(OWN_BROWSER_SERVER);
        throw err;
    }
};

// Sends a tab on its way without waiting for the page to load: the window answers as soon as it can be watched, and the
// picture shows the page arriving like any browser does.
const go = (page: Page, url: string | undefined, deps: OwnBrowserDeps): void => {
    if (url === undefined || url === "") {
        return;
    }
    void page.goto(url, { waitUntil: "commit" }).catch((err: unknown) => deps.warn({ err, url }, "own browser: navigation failed"));
};

/** Opens a tab in the person's own window, starting the window first if it isn't running. */
export const openOwnBrowser = async (deps: OwnBrowserDeps, url: string | undefined): Promise<OpenBrowserResult> => {
    let started = false;
    if (!browserSessionRunning(OWN_BROWSER_SESSION)) {
        if (starting === undefined) {
            started = true;
            starting = start(deps).finally(() => {
                starting = undefined;
            });
        }
        await starting;
    }
    // The window a start just opened already has its blank tab; the first address belongs in it.
    const blank = started ? browserSessionBlankPage(OWN_BROWSER_SESSION) : undefined;
    if (blank !== undefined) {
        go(blank.page, url, deps);
        return { name: OWN_BROWSER_SESSION, pageId: blank.id };
    }
    const tab = await browserSessionNewTab(OWN_BROWSER_SESSION);
    if (tab === undefined) {
        throw new Error("your browser window closed while the tab was opening");
    }
    go(tab.page, url, deps);
    return tab.id === undefined ? { name: OWN_BROWSER_SESSION } : { name: OWN_BROWSER_SESSION, pageId: tab.id };
};
