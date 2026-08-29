/* THE ZOD-FREE HALF OF THE BROWSER CONNECTOR'S WIRE: three URL builders, one code format, two message names.
 *
 * Split out of webext-protocol.ts for exactly one reason, and it is a real one rather than tidiness. A browser
 * extension's CONTENT SCRIPT — the few lines that run on the sandbox's own page to hand a pairing code over —
 * needs two of these constants and nothing else. Importing them through the contract's barrel pulls in every
 * schema this repo has and the whole of zod with them: measured at 1.1 MB of JavaScript injected into a page,
 * for two strings. Nothing here imports anything, so that file is now a few hundred bytes.
 *
 * The rule for what may live here: no imports, ever. A zod schema in this file would undo the split silently.
 */

// The URL the extension dials, given the sandbox's public URL. Carries no credential — the token rides the
// hello frame (webext-protocol.ts). One place builds it, so the extension and the daemon route cannot disagree
// about where the door is.
export const webextConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/webext/connect`;

/* Where the extension POSTS a site's session when the owner asks for one to be handed to the sandbox
 * ("Connect this site"), authenticated by the same enrollment token as a bearer.
 *
 * A SEPARATE DOOR FROM THE SOCKET, deliberately, and this is the load-bearing decision of that feature: the
 * socket's answers are MCP tool results, which means they land in the agent's context. Cookies must never do
 * that. So the payload goes browser → daemon directly, the agent's tool call gets back a sentence and a count,
 * and the one thing that would be catastrophic to leak is the one thing the model never sees. */
export const webextSessionUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/session`;

/* ---- the pairing code: the one string that travels from the sandbox's card into the extension ----
 *
 * A connected computer is paired by a shell one-liner, which can carry two values in two environment variables
 * because a terminal is a place where long strings are normal. A browser extension's popup is not: what a
 * person will actually do there is paste ONE thing, once, and anything that asks them to copy a URL into one
 * box and a token into another is a flow that fails on the second box.
 *
 * So both halves ride in one code. It is not encryption and does not pretend to be — base64url of two fields,
 * so that the thing on the clipboard is opaque enough not to be edited by hand, short enough to paste, and
 * carries its own sandbox address, which is the field a person could not possibly be expected to type. The
 * secret in it is the pairing token, which is single-use and expires in ten minutes (webext-store.ts).
 *
 * The prefix is a version marker, and it is here so that a code from an older sandbox meets a clear "this code
 * is from a different version" in the extension rather than a JSON parse error. */
const PAIRING_PREFIX = "ixb1_";

const base64url = (value: string): string => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const webextPairingCode = (pairing: { readonly url: string; readonly token: string }): string =>
    `${PAIRING_PREFIX}${base64url(JSON.stringify({ url: pairing.url, token: pairing.token }))}`;

// The extension's side. Undefined for anything that is not one of ours, so a person who pasted the wrong thing
// is told that rather than watching a connection attempt to nowhere.
export const parseWebextPairingCode = (code: string): { readonly url: string; readonly token: string } | undefined => {
    const trimmed = code.trim();
    if (!trimmed.startsWith(PAIRING_PREFIX)) {
        return undefined;
    }
    try {
        const decoded = JSON.parse(atob(trimmed.slice(PAIRING_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/"))) as {
            url?: unknown;
            token?: unknown;
        };
        // An http(s) URL and a non-empty token, or nothing: the extension is about to open a socket to whatever
        // this says, so "looks like a URL" is checked here rather than by the WebSocket constructor throwing.
        if (typeof decoded.url !== "string" || typeof decoded.token !== "string" || decoded.token === "" || !/^https?:\/\//.test(decoded.url)) {
            return undefined;
        }
        return { url: decoded.url, token: decoded.token };
    } catch {
        return undefined;
    }
};

/* How the sandbox's own page hands that code over without anybody copying anything: it posts this message on
 * its own window, and the extension's content script (which is only ever loaded on the sandbox's own origins)
 * picks it up and answers.
 *
 * A window message rather than `chrome.runtime.sendMessage` from the page, which would be the obvious route,
 * because that one needs the extension's STORE ID baked into the web app — a value that does not exist until
 * the listing is approved, differs for an unlisted build, and would make a locally-loaded extension
 * un-pairable. A window message needs neither side to know the other's identity: the content script is proof
 * enough that the extension is installed, and the page's origin is proof enough for the extension. */
export const WEBEXT_PAIR_MESSAGE = "intentic:webext:pair";
export const WEBEXT_PAIRED_MESSAGE = "intentic:webext:paired";
