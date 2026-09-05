import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract";

/* THE ENFORCEMENT POINT — every decision about what may happen in this browser is made here, in the browser,
 * and nowhere else.
 *
 * That placement is the whole security argument, exactly as it is for a connected device (@intentic/machine's
 * policy.ts). The sandbox could be compromised; the agent in it reads the open internet all day and can be
 * talked into things. Neither can widen what happens here, because the sandbox does not decide — it asks, and
 * this answers. The daemon checks no scope, so there is no second implementation to drift out of agreement
 * with this one.
 *
 * There are THREE gates, and it is worth being clear about which is which, because only one of them is ours:
 *
 *   1. Chrome's own host permissions. The person granted this extension `https://github.com/*` and can revoke
 *      it in the browser's settings. Injection into anything else FAILS AT THE BROWSER, below this file.
 *   2. The per-site mode (read / act), below. Chrome has no concept for "may look, may not touch", so this
 *      supplies it.
 *   3. The sandbox's switches (WebExtScopes), pushed down the socket and cached. Coarse and global: whether
 *      this connection does acting, screenshots or session handovers at all.
 *
 * A refusal is a VALUE rather than an exception at the boundary: it travels back as an ordinary tool result
 * naming what would fix it, so the agent tells the person which switch to flip instead of reporting a broken
 * sandbox and retrying. */

export class RefusedError extends Error {}

/* THE ONE ORIGIN THAT IS NEVER A SITE THE AGENT MAY WORK ON: the sandbox's own.
 *
 * The extension holds a host permission for it — it has to, or it could not `fetch` the enrollment or the
 * session door — and that permission arrives through exactly the same `chrome.permissions` store every granted
 * site does. Left alone, the sandbox's own app would appear in the grant list as a site the agent had been
 * allowed on, and it would be able to drive the app that is driving it: click its own approval dialogs, read
 * another conversation, revoke a different capability. So the permission that exists to reach the daemon is
 * subtracted from the permission to browse, in the one place both are read. */
export const sandboxOwnOrigin = (sandboxUrl: string | undefined): string | undefined => {
    if (sandboxUrl === undefined) {
        return undefined;
    }
    try {
        return `${new URL(sandboxUrl).origin}/*`;
    } catch {
        return undefined;
    }
};

// Chrome's match pattern for one origin, which is both what `chrome.permissions` takes and what the browser's
// own permission list shows the person. Derived in one place so a grant, a check and a card can never disagree
// about what "this site" means. Undefined for anything that is not an http(s) page: a chrome:// tab, a PDF
// viewer, the new-tab page — none of which an extension may touch at all.
export const originPattern = (url: string | undefined): string | undefined => {
    if (url === undefined) {
        return undefined;
    }
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? `${parsed.origin}/*` : undefined;
    } catch {
        return undefined;
    }
};

// A readable site name for a message, from a pattern or a URL. "github.com", not "https://github.com/*".
export const siteOf = (urlOrPattern: string): string => urlOrPattern.replace(/^https?:\/\//, "").replace(/\/\*?$/, "");

/* What this browser will let the agent do on one page. `granted` is Chrome's answer (does the extension hold a
 * host permission for it), `mode` is ours. The two are separate because they are revoked in different places:
 * Chrome's in the browser's settings, ours in this extension's popup. */
export const decide = (options: {
    readonly url: string | undefined;
    readonly granted: boolean;
    readonly mode: WebExtGrant["mode"] | undefined;
    readonly need: "read" | "act";
    readonly scopes: WebExtScopes;
    readonly paused: boolean;
    // The sandbox's own origin, when this browser is paired with one. Never a site to work on: see above.
    readonly own?: string | undefined;
}): { readonly allowed: true } | { readonly allowed: false; readonly message: string } => {
    if (options.paused) {
        return { allowed: false, message: `This browser is paused: its owner stopped the agent in the extension. Ask them to resume it.` };
    }
    const pattern = originPattern(options.url);
    if (pattern === undefined) {
        return {
            allowed: false,
            message: `That tab is not an ordinary web page (a browser settings page, an extension page or a local file), and no extension may touch it.`,
        };
    }
    const site = siteOf(pattern);
    if (options.own !== undefined && pattern === options.own) {
        return {
            allowed: false,
            message: `That tab is the sandbox's own app. This connection exists to work on OTHER sites; use your ordinary tools for anything here.`,
        };
    }
    if (!options.granted) {
        return {
            allowed: false,
            message: `Not allowed on ${site}. Call ask_access with a plain reason and stop: the person allows it in their browser, or does not.`,
        };
    }
    if (options.need === "read" && options.scopes.read !== "on") {
        return {
            allowed: false,
            message: `Refused: "Read the page" is switched off for this browser. Turn it on in its capability card to allow this.`,
        };
    }
    if (options.need === "act") {
        if (options.scopes.act !== "on") {
            return {
                allowed: false,
                message: `Refused: "Click and type" is switched off for this browser. Turn it on in its capability card to allow this.`,
            };
        }
        if (options.mode !== "act") {
            return {
                allowed: false,
                message: `${site} is allowed for reading only. The person can change it to "read and act" in the extension; ask them, and say what you need to do there.`,
            };
        }
    }
    return { allowed: true };
};

// May anything happen at all right now: the kill switch, asked without a tab in hand. For the tools whose
// subject is the browser rather than a page (navigating one, handing a session over).
export const assertRunning = (paused: boolean): void => {
    if (paused) {
        throw new RefusedError(`This browser is paused: its owner stopped the agent in the extension. Ask them to resume it.`);
    }
};

// The global switches, for the tools that are not about one page. One message shape for all of them, naming the
// card's own label, so the person is told exactly which control to flip.
export const assertScope = (scopes: WebExtScopes, scope: "read" | "act" | "screenshot" | "cookies"): void => {
    if (scopes[scope] === "on") {
        return;
    }
    const label = {
        read: "Read the page",
        act: "Click and type",
        screenshot: "Take screenshots",
        cookies: "Hand sessions to the sandbox",
    }[scope];
    throw new RefusedError(`Refused: "${label}" is switched off for this browser. Turn it on in its capability card to allow this.`);
};

/* Does this action need a human's click first? The `confirm` switch decides the policy; `sensitive` is what the
 * page said about the element (page/driver.ts's describeRef).
 *
 * "sensitive" is the default and the interesting case: a submit next to a password field, a button that says
 * Pay or Delete. The asymmetry is deliberate — asking too often costs a click, asking too rarely costs
 * somebody's money — so the page-side test is broad and this is a plain OR. */
export const needsConfirm = (scopes: WebExtScopes, sensitive: boolean): boolean =>
    scopes.confirm === "always" || (scopes.confirm === "sensitive" && sensitive);
