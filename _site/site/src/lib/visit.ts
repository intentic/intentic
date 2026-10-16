/* WHAT THE SITE COUNTS, AND HOW IT CARRIES A VISIT'S SOURCE TO THE APP (2026-10-15).

   The site counts two things: a page seen, and a press on a link into the app. It stores nothing in the browser (no
   cookie, no local or session storage), loads no third-party script, and sends a fixed, small shape to its own Worker
   at `/wire/site`, which turns it into PostHog events (lib/site-wire.ts). A visitor whose browser sends Global Privacy
   Control or Do Not Track is not counted at all.

   With nothing stored, where a visit came from has to travel in the links themselves. A visit that lands with campaign
   tags (`utm_*`), or from another site, keeps that source on every link it follows inside the site, and hands it to the
   app's sign-in link, where the app records it with the sign-up (the app's analytics.ts reads it at boot). A visit with
   no outside source reaches the app tagged `utm_source=intentic.dev`, with the page it left from as `utm_content`.
   Chosen over a first-party cookie, which would have needed asking every European visitor before counting anything. */

export const CAMPAIGN_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type CampaignKey = (typeof CAMPAIGN_KEYS)[number];
/** A visit's source, in the five standard campaign tags; each absent when the visit did not carry it. */
export interface Campaign {
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_term?: string;
    utm_content?: string;
}

const MAX_PARAM = 150;

/** The campaign tags in a query string, trimmed and bounded; empty when it has none. */
export const campaignOf = (search: string): Campaign => {
    const params = new URLSearchParams(search);
    const campaign: Campaign = {};
    for (const key of CAMPAIGN_KEYS) {
        const value = params.get(key)?.trim();
        if (value !== undefined && value !== "") {
            campaign[key] = value.slice(0, MAX_PARAM);
        }
    }
    return campaign;
};

/** Another site's origin, from a referrer address; undefined for none, this site's own, or something unreadable. */
export const referringHost = (referrer: string, ownHost: string): string | undefined => {
    if (referrer === "") {
        return undefined;
    }
    try {
        const { host } = new URL(referrer);
        return host === ownHost || host === "" ? undefined : host;
    } catch {
        // allow(silent-catch): a referrer that is not a URL names no site to credit, which is the answer.
        return undefined;
    }
};

/**
 * Where this visit came from, as campaign tags: the tags it landed with, else the other site that sent it (as a
 * referral), else nothing.
 */
export const sourceOf = (search: string, referrer: string, ownHost: string): Campaign => {
    const landed = campaignOf(search);
    if (landed.utm_source !== undefined) {
        return landed;
    }
    const from = referringHost(referrer, ownHost);
    return from === undefined ? landed : { ...landed, utm_source: from, utm_medium: "referral" };
};

/**
 * A link's address with the visit's source added, or undefined to leave it as it is. Same-site page links carry an
 * outside source onward; app links always carry one, this site itself when there is no other. A link that already has
 * campaign tags is left as it is.
 */
export const taggedHref = (href: string, page: URL, source: Campaign, appOrigin: string): string | undefined => {
    let target: URL;
    try {
        target = new URL(href, page);
    } catch {
        // allow(silent-catch): an href that is not a URL is no link to tag; it is left as the page wrote it.
        return undefined;
    }
    const toApp = target.origin === appOrigin;
    const toSite = target.origin === page.origin;
    if (!toApp && !toSite) {
        return undefined;
    }
    // A same-site file (a download, a script, llms.txt) is not a page a visit continues on, and a link that names its
    // own campaign was tagged on purpose.
    if ((toSite && /\.[a-z0-9]+$/iu.test(target.pathname)) || CAMPAIGN_KEYS.some((key) => target.searchParams.has(key))) {
        return undefined;
    }
    const tags: Campaign = toApp && source.utm_source === undefined ? { utm_source: page.host, utm_medium: "site" } : { ...source };
    if (toApp && tags.utm_content === undefined) {
        tags.utm_content = page.pathname;
    }
    let changed = false;
    for (const key of CAMPAIGN_KEYS) {
        const value = tags[key];
        if (value !== undefined && !target.searchParams.has(key)) {
            target.searchParams.set(key, value);
            changed = true;
        }
    }
    return changed ? target.href : undefined;
};

/** What the Worker accepts, one event at a time: names and bounds are checked again there. */
export interface VisitEvent {
    readonly event: "$pageview" | "site_cta_clicked";
    readonly path: string;
    readonly referrer?: string;
    readonly campaign: Campaign;
    readonly cta?: string;
    readonly target?: string;
}

/** Whether this browser asked not to be followed: Global Privacy Control, or the older Do Not Track. */
export const optedOut = (nav: { globalPrivacyControl?: boolean; doNotTrack?: string | null }): boolean =>
    nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.doNotTrack === "yes";

const send = (events: VisitEvent[]): void => {
    const body = JSON.stringify({ events });
    // A beacon survives the page unloading under a click; fetch keepalive where there is none.
    if ("sendBeacon" in navigator && navigator.sendBeacon("/wire/site", new Blob([body], { type: "text/plain" }))) {
        return;
    }
    // allow(silent-catch): a count that does not arrive costs a count, never the page it was counting.
    void fetch("/wire/site", { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } }).catch(() => undefined);
};

/** Counts this page, tags its links with the visit's source, and counts presses on links into the app. */
export const startVisit = (appOrigin: string): void => {
    const page = new URL(location.href);
    const source = sourceOf(page.search, document.referrer, page.host);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        const next = taggedHref(link.getAttribute("href") ?? "", page, source, appOrigin);
        if (next !== undefined) {
            link.href = next;
        }
    }
    if (optedOut(navigator)) {
        return;
    }
    const from = referringHost(document.referrer, page.host);
    const view: VisitEvent = from === undefined ? { event: "$pageview", path: page.pathname, campaign: source } : { event: "$pageview", path: page.pathname, referrer: from, campaign: source };
    send([view]);
    document.addEventListener(
        "click",
        (event) => {
            const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (!(link instanceof HTMLAnchorElement) || new URL(link.href).origin !== appOrigin) {
                return;
            }
            const cta = (link.dataset.cta ?? link.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
            send([{ event: "site_cta_clicked", path: page.pathname, campaign: source, cta, target: new URL(link.href).pathname }]);
        },
        { capture: true },
    );
};
