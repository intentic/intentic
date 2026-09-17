// What the address bar sends the browser for what was typed: an address as it stands, a host given its scheme, or
// anything else as a search. The same rule an omnibox applies, since the chrome is ours and Chromium's never sees the
// text.

// Where a query goes; the sandbox's browser has no search engine of its own, and this one asks nothing of the user.
const SEARCH_URL = `https://duckduckgo.com/?q=`;

// Something with a scheme (`https:`, `about:`, `file:`), taken as written. A colon followed by digits and nothing
// but a path is a host with a port (`localhost:5173`), not a scheme.
const SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i;
// A host, with an optional port and path: `example.com`, `docs.example.com/guide`, `localhost:5173`, `10.0.0.2:8080`.
const HOST = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[\w-]+(?:\.[\w-]+)+)(?::\d{1,5})?(?:[/?#].*)?$/i;
// Hosts a certificate is not expected on; everything else is asked over https first.
const PLAIN_HTTP = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::|\/|$)/i;

export const toUrl = (typed: string): string | undefined => {
    const text = typed.trim();
    if (text === ``) {
        return undefined;
    }
    if (SCHEME.test(text)) {
        return text;
    }
    // A space is never in a host, so anything containing one is a search however host-like its first word.
    if (!/\s/.test(text) && HOST.test(text)) {
        return `${PLAIN_HTTP.test(text) ? `http` : `https`}://${text}`;
    }
    return `${SEARCH_URL}${encodeURIComponent(text)}`;
};
