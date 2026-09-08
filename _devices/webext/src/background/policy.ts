import type { WebExtGrant, WebExtScopes } from "@intentic/sandbox-contract";

// The enforcement point: everything about what may happen in this browser is decided here. Three gates, only one
// of which is ours: Chrome's host permissions (browser settings), the per-site read/act mode (this layer), and
// the sandbox's global switches, cached from the socket. A refusal is a value, not an exception, naming what would fix
// it.

export class RefusedError extends Error {}

// The sandbox's own origin is never a site to work on, even though the extension holds a host permission for it
// (needed to fetch the enrollment). Left alone, the agent could drive the app driving it: click its own dialogs,
// read another conversation.
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

// Chrome's match pattern for one origin, derived in one place so a grant, a check and a card never disagree about
// what "this site" means. Undefined for anything not an http(s) page, none of which an extension may touch.
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

// What this browser lets the agent do on one page. `granted` is Chrome's answer, `mode` is ours; kept separate
// since each is revoked in a different place (browser settings vs. this extension's popup).
export const decide = (options: {
    readonly url: string | undefined;
    readonly granted: boolean;
    readonly mode: WebExtGrant["mode"] | undefined;
    readonly need: "read" | "act";
    readonly scopes: WebExtScopes;
    readonly paused: boolean;
    // The sandbox's own origin, when paired with one; never a site to work on.
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

// The kill switch, asked without a tab in hand, for tools whose subject is the browser rather than a page.
export const assertRunning = (paused: boolean): void => {
    if (paused) {
        throw new RefusedError(`This browser is paused: its owner stopped the agent in the extension. Ask them to resume it.`);
    }
};

// The global switches, for tools not about one page; one message shape naming the card's own label, so the
// person knows which control to flip.
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

// Whether an action needs a human's click first: `confirm` sets the policy, `sensitive` is what the page said
// about the element. Asking too often costs a click, too rarely costs money, so the page-side test stays broad
// and this is a plain OR.
export const needsConfirm = (scopes: WebExtScopes, sensitive: boolean): boolean =>
    scopes.confirm === "always" || (scopes.confirm === "sensitive" && sensitive);
