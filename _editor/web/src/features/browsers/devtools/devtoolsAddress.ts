// Where the DevTools frame opens: the frontend Chromium ships, at the path the daemon minted (with its ticket), told to
// connect to the page's socket on the same sandbox address. The frontend takes the socket as `ws=` or `wss=` followed by
// host and path, no scheme, so it is the sandbox's own address that decides which.

export const devtoolsFrameSrc = (base: string | undefined, opened: { readonly path: string; readonly socket: string }): string | undefined => {
    if (base === undefined || base === `` || !URL.canParse(base)) {
        return undefined;
    }
    const at = new URL(base);
    const prefix = at.pathname.replace(/\/$/u, ``);
    const scheme = at.protocol === `https:` ? `wss` : `ws`;
    return `${at.origin}${prefix}${opened.path}?${scheme}=${at.host}${prefix}${opened.socket}`;
};
