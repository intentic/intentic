// Whether a target someone hands the page (a notification's url, a remembered route, a path the desktop app asks this
// page to open) is one of the page's own routes. A prefix test is not enough: `//host` and `/\host` both start with a
// slash, and a browser resolves either to another host, so a navigation to them leaves the app. The rule is the one
// the service worker applies to a notification tap (public/sw.js): resolve the target against this origin, the way a
// navigation would, and keep it only when it lands on the same origin.

// Stands in for the page's origin where there is no page (a unit test without a window): any http origin decides the
// same thing, since only whether the resolved target leaves it matters.
const NO_PAGE_ORIGIN = `http://in-app.invalid`;

const pageOrigin = (): string => globalThis.location?.origin ?? NO_PAGE_ORIGIN;

/** The path, query and hash of a URL already resolved, when it is on this origin. */
export const sameOriginPath = (url: URL, origin: string = pageOrigin()): string | undefined =>
    url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : undefined;

/**
 * The in-app route a target names, normalised the way the browser would read it, or undefined. Only a rooted path
 * counts: an absolute URL, a relative one and anything that resolves off this origin are not routes of ours.
 */
export const inAppPath = (target: string, origin: string = pageOrigin()): string | undefined => {
    if (!target.startsWith(`/`)) {
        return undefined;
    }
    try {
        return sameOriginPath(new URL(target, origin), origin);
    } catch {
        // allow(silent-catch): a target the URL parser refuses is not a route; the caller treats it as nothing to open.
        return undefined;
    }
};
