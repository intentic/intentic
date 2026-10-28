// Zod-free half of the browser connector's wire: URL builders, pairing code format, message names. Split from
// webext-protocol.ts since a content script only needs two constants and importing the barrel pulls in all of zod. No
// imports allowed here, ever.

// URL the extension dials, from the sandbox's public URL; carries no credential, the token rides the hello frame.
export const webextConnectUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/^http/, "ws").replace(/\/$/, "")}/system/webext/connect`;

// Where the extension redeems a pairing code's one-time token (sent as `x-intentic-pair`) for its durable token; the
// answer is a PeerEnrollmentAnswer.
export const webextEnrollUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/enroll`;

// Where the extension POSTs a site's session when the owner connects it, bearer-authenticated. A separate door from the
// socket, since the socket's answers land in the agent's context and cookies must never reach a model.
export const webextSessionUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/session`;

// The reverse direction: lends a sandbox account's session to this browser for a step only it can do (passkey, 2FA,
// SSO). Separate from webextSessionUrl since the two have distinct refusals; cookies return on this request, never as
// an MCP result.
export const webextLendUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/lend`;

// Where the extension collects a stored secret it was handed a ticket to type. Its own door for the reason the two above
// are: a tool answer over the socket lands in the model's context, and this value must never reach one.
export const webextSecretUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/secret`;

// Where the extension tells its sandbox that site access changed outside the popup (2026-10-20), bearer-authenticated.
export const webextGrantsChangedUrl = (sandboxUrl: string): string => `${sandboxUrl.replace(/\/$/, "")}/system/webext/grants-changed`;

// The tool the daemon calls on a browser to type a secret into its focused field, taking only a ticket the daemon
// minted for that one call. The agent's own mount of the browser never lists it (webext-peer.ts): a model holding the
// tool would hold nothing it could use, so it is not offered.
export const WEBEXT_TICKET_TOOL = "type_ticket";

// How long a ticket waits for its browser to collect it. Both sides read it: the extension's own question to the person
// has to be answered inside it, or the ticket it then presents has already lapsed.
export const WEBEXT_TICKET_TTL_MS = 60_000;

// One pasteable code, not two fields: base64url of {url, token, name}, since a popup gets one paste, not two boxes.
// `token` is single-use and expires in ten minutes; the prefix versions the format. `name` (2026-10-28) is what the
// sandbox is called, so an extension paired with several can tell them apart by more than a hostname; optional both
// ways, since a code without it is still a whole code and an extension that predates it ignores it.
const PAIRING_PREFIX = "ixb1_";

// Long enough for any sandbox's name; a longer one is cut rather than refused.
const NAME_LIMIT = 80;

export interface WebextPairing {
    readonly url: string;
    readonly token: string;
    readonly name?: string;
}

// btoa takes Latin-1 only, so a name in any other script goes through UTF-8 first.
const base64url = (value: string): string =>
    btoa(String.fromCodePoint(...new TextEncoder().encode(value)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");

const fromBase64url = (value: string): string =>
    new TextDecoder().decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.codePointAt(0) ?? 0));

export const webextPairingCode = (pairing: WebextPairing): string => {
    const name = pairing.name?.trim().slice(0, NAME_LIMIT) ?? "";
    const carried = name === "" ? { url: pairing.url, token: pairing.token } : { url: pairing.url, token: pairing.token, name };
    return `${PAIRING_PREFIX}${base64url(JSON.stringify(carried))}`;
};

// The extension's side; undefined for anything not one of ours, so a bad paste is reported rather than attempted.
export const parseWebextPairingCode = (code: string): WebextPairing | undefined => {
    const trimmed = code.trim();
    if (!trimmed.startsWith(PAIRING_PREFIX)) {
        return undefined;
    }
    try {
        const decoded = JSON.parse(fromBase64url(trimmed.slice(PAIRING_PREFIX.length))) as {
            url?: unknown;
            token?: unknown;
            name?: unknown;
        };
        // Checked here (http(s) URL, non-empty token) rather than left to the WebSocket constructor to throw.
        if (typeof decoded.url !== "string" || typeof decoded.token !== "string" || decoded.token === "" || !/^https?:\/\//.test(decoded.url)) {
            return undefined;
        }
        const name = typeof decoded.name === "string" ? decoded.name.trim().slice(0, NAME_LIMIT) : "";
        return name === "" ? { url: decoded.url, token: decoded.token } : { url: decoded.url, token: decoded.token, name };
    } catch {
        return undefined;
    }
};

// Window message the sandbox's page posts for its content script to pick up, not chrome.runtime.sendMessage, which
// would need the extension's store id baked into the web app.
export const WEBEXT_PAIR_MESSAGE = "intentic:webext:pair";
export const WEBEXT_PAIRED_MESSAGE = "intentic:webext:paired";
