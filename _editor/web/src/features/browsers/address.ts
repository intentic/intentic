import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from "@intentic/sandbox-contract/schemas/browsing";
import { searchUrl } from "./omnibox/engines";

// What the address bar sends the browser for what was typed: an address as it stands, a host given its scheme, or
// anything else as a search. The same rule an omnibox applies, since the chrome is ours and Chromium's never sees the
// text. Where a search goes is the sandbox's `searchEngine` setting (omnibox/engines.ts); Brave unless it says otherwise.

// Something with a scheme (`https:`, `about:`, `file:`), taken as written. A colon followed by digits and nothing
// but a path is a host with a port (`localhost:5173`), not a scheme.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
// A host, with an optional port and path: `example.com`, `docs.example.com/guide`, `localhost:5173`, `10.0.0.2:8080`.
const HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+(?:\.[\w-]+)+)(?::\d{1,5})?(?:[/?#].*)?$/i;
// Hosts a certificate is not expected on; everything else is asked over https first.
const PLAIN_HTTP = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::|\/|$)/i;

// The address for typed text that names one, undefined for anything that would be a search.
export const addressOf = (typed: string): string | undefined => {
    const text = typed.trim();
    if (SCHEME.test(text)) {
        return text;
    }
    // A space is never in a host, so anything containing one is a search however host-like its first word.
    if (text !== `` && !/\s/.test(text) && HOST.test(text)) {
        return `${PLAIN_HTTP.test(text) ? `http` : `https`}://${text}`;
    }
    return undefined;
};

export const toUrl = (typed: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string | undefined => {
    const text = typed.trim();
    if (text === ``) {
        return undefined;
    }
    return addressOf(text) ?? searchUrl(engine, text);
};

// Ctrl+Enter's address: a bare word wrapped as a site (`intentic` to `https://www.intentic.com`), the shortcut every
// desktop browser keeps. Anything already an address, or with a space or a dot in it, is left to Enter's own rule.
export const wrappedUrl = (typed: string): string | undefined => {
    const text = typed.trim();
    return /^[\p{L}\p{N}-]+$/u.test(text) ? `https://www.${text}.com` : undefined;
};

// How the address bar draws an address while nobody is editing it: the scheme dropped (the padlock says it instead),
// and the host apart from the rest, so a lookalike domain is the part the eye lands on. Undefined for anything without
// a host (`about:blank`, `data:`, `file:`), which is shown as written.
export interface AddressParts {
    readonly host: string;
    readonly rest: string;
}

const WEB_SCHEMES = new Set([`https:`, `http:`]);

const parsed = (address: string): URL | undefined => {
    try {
        return new URL(address);
    } catch {
        // allow(silent-catch): not an address at all (empty, a bare word) has no parts to draw.
        return undefined;
    }
};

export const addressParts = (address: string): AddressParts | undefined => {
    const url = parsed(address);
    if (url === undefined || url.host === `` || !WEB_SCHEMES.has(url.protocol)) {
        return undefined;
    }
    // A bare root reads as the site itself, the way a browser shows `example.com` rather than `example.com/`.
    const path = url.pathname === `/` && url.search === `` && url.hash === `` ? `` : url.pathname;
    return { host: url.host, rest: `${path}${url.search}${url.hash}` };
};

// The padlock: secure over https, flagged over plain http, and nothing at all where the question doesn't arise.
export const securityOf = (address: string): `secure` | `insecure` | undefined => {
    const url = parsed(address);
    if (url === undefined || url.host === ``) {
        return undefined;
    }
    return url.protocol === `https:` ? `secure` : url.protocol === `http:` ? `insecure` : undefined;
};
