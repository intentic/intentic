// Zod-free half of the phone door's wire: URL builders and the pairing code. Split from phone-protocol.ts so the
// editor's pairing dialog does not pull zod in for two string functions. No imports allowed here, ever.

const base = (sandboxUrl: string): string => sandboxUrl.replace(/\/$/, "");

// URL the phone dials, from the sandbox's public URL; carries no credential, the token rides the hello frame.
export const phoneConnectUrl = (sandboxUrl: string): string => `${base(sandboxUrl).replace(/^http/, "ws")}/system/phones/connect`;

// Where the phone redeems its one-time pairing for its durable token (header `x-intentic-pair`).
export const phoneEnrollUrl = (sandboxUrl: string): string => `${base(sandboxUrl)}/system/phones/enroll`;

// One code rather than two fields, like the browser extension's: base64url of {url, token}, the prefix versioning the
// format. `token` is single-use and expires in ten minutes.
const PAIRING_PREFIX = "ixp1_";

// Where a pairing opens: an App Link the app claims (intentic.dev serves its assetlinks.json), so scanning the code
// with the phone's camera opens the app straight on the pairing screen, and a phone without the app lands on the page
// that offers it. The code rides the fragment, which no server ever receives, so no access log holds a live pairing.
export const PHONE_PAIR_LINK = "https://intentic.dev/phone/pair";

const base64url = (value: string): string => btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const phonePairingCode = (pairing: { readonly url: string; readonly token: string }): string =>
    `${PAIRING_PREFIX}${base64url(JSON.stringify({ url: pairing.url, token: pairing.token }))}`;

export const phonePairingLink = (pairing: { readonly url: string; readonly token: string }): string =>
    `${PHONE_PAIR_LINK}#${phonePairingCode(pairing)}`;

// The phone's side, and the editor's for a pasted code; undefined for anything not one of ours. Accepts the bare code
// or the whole link, since a person may paste either.
export const parsePhonePairingCode = (input: string): { readonly url: string; readonly token: string } | undefined => {
    const trimmed = input.trim();
    // The site serves the page with a trailing slash, so a link copied out of the browser may carry one.
    const linked = [`${PHONE_PAIR_LINK}#`, `${PHONE_PAIR_LINK}/#`].find((prefix) => trimmed.startsWith(prefix));
    const code = linked === undefined ? trimmed : trimmed.slice(linked.length);
    if (!code.startsWith(PAIRING_PREFIX)) {
        return undefined;
    }
    try {
        const padded = code.slice(PAIRING_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/");
        const decoded = JSON.parse(atob(padded)) as { url?: unknown; token?: unknown };
        if (typeof decoded.url !== "string" || typeof decoded.token !== "string" || decoded.token === "" || !/^https?:\/\//.test(decoded.url)) {
            return undefined;
        }
        return { url: decoded.url, token: decoded.token };
    } catch {
        return undefined;
    }
};
