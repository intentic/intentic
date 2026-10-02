// Normalizes whatever the user pasted into the base URL for daemon calls, or undefined if it can't be one.
// Forgiving about shape (hostname, full URL, trailing slash); strict about scheme.
export const normalizeDaemonUrl = (raw: string): string | undefined => {
    const trimmed = raw.trim();
    if (trimmed === ``) {
        return undefined;
    }
    // A bare hostname parses as a URL only with a scheme; assumes https so an unscheme pasted domain still works.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    if (!URL.canParse(withScheme)) {
        return undefined;
    }
    const url = new URL(withScheme);
    // A hostname with no dot is a typo, not a domain (`localhost` included); http can't reach this HTTPS app.
    if (url.protocol !== `https:` || !url.hostname.includes(`.`)) {
        return undefined;
    }
    // Keeps a path prefix (proxy-served sandbox), drops a trailing slash (avoids `//health`), drops query/hash.
    return `${url.origin}${url.pathname.replace(/\/+$/, ``)}`;
};
