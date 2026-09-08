// Zod-free half of the browser connector's wire: URL builders, pairing code format, message names. Split from
// webext-protocol.ts since a content script only needs two constants and importing the barrel pulls in all of zod. No
// imports allowed here, ever.

// URL the extension dials, from the sandbox's public URL; carries no credential, the token rides the hello frame.
export const webextConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/webext/connect`;

// Where the extension POSTs a site's session when the owner connects it, bearer-authenticated. A separate door from the
// socket, since the socket's answers land in the agent's context and cookies must never reach a model.
export const webextSessionUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/session`;

// The reverse direction: lends a sandbox account's session to this browser for a step only it can do (passkey, 2FA,
// SSO). Separate from webextSessionUrl since the two have distinct refusals; cookies return on this request, never as
// an MCP result.
export const webextLendUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/lend`;

// One pasteable code, not two fields: base64url of {url, token}, since a popup gets one paste, not two boxes. `token`
// is single-use and expires in ten minutes; the prefix versions the format.
const PAIRING_PREFIX = "ixb1_";

const base64url = (value: string): string => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const webextPairingCode = (pairing: { readonly url: string; readonly token: string }): string =>
    `${PAIRING_PREFIX}${base64url(JSON.stringify({ url: pairing.url, token: pairing.token }))}`;

// The extension's side; undefined for anything not one of ours, so a bad paste is reported rather than attempted.
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
        // Checked here (http(s) URL, non-empty token) rather than left to the WebSocket constructor to throw.
        if (typeof decoded.url !== "string" || typeof decoded.token !== "string" || decoded.token === "" || !/^https?:\/\//.test(decoded.url)) {
            return undefined;
        }
        return { url: decoded.url, token: decoded.token };
    } catch {
        return undefined;
    }
};

// Window message the sandbox's page posts for its content script to pick up, not chrome.runtime.sendMessage, which
// would need the extension's store id baked into the web app.
export const WEBEXT_PAIR_MESSAGE = "intentic:webext:pair";
export const WEBEXT_PAIRED_MESSAGE = "intentic:webext:paired";
