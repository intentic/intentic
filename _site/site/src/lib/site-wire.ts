/* THE SITE'S COUNTER, ON THE WORKER'S SIDE (2026-10-15). The browser half is lib/visit.ts.

   `/wire/site` takes the small, fixed shape visit.ts sends, checks every name and bound again (anyone can post to it),
   and forwards PostHog events built here, so nothing the browser invents reaches PostHog. Who a visitor is, for counting
   unique visitors, is decided here and never stored anywhere: a hash of a secret salt, today's UTC date, the connecting
   address and the browser's user agent. It changes every day and cannot be turned back into the address without the
   salt. No address leaves the Worker: PostHog gets the visitor's country from Cloudflare instead, with its own IP lookup
   switched off. Events carry no person profile.

   With no `POSTHOG_KEY` set on the Worker (a fork, a preview) the endpoint answers 204 and sends nothing; with no
   `WIRE_SALT`, each page view counts as its own visitor rather than linking a day's visits. */

import { CAMPAIGN_KEYS, type Campaign } from "./visit";

export interface WireEnv {
    readonly POSTHOG_KEY?: string;
    readonly WIRE_SALT?: string;
    /** PostHog's ingestion host; the US cloud when unset. */
    readonly POSTHOG_HOST?: string;
}

const EVENTS = new Set(["$pageview", "site_cta_clicked"]);
const MAX_BODY = 8 * 1024;
const MAX_EVENTS = 5;
const MAX_PATH = 300;
const MAX_HOST = 200;
const MAX_CTA = 80;
const MAX_PARAM = 150;

export interface CheckedEvent {
    readonly event: string;
    readonly path: string;
    readonly referrer: string | undefined;
    readonly campaign: Campaign;
    readonly cta: string | undefined;
    readonly target: string | undefined;
}

/** What `JSON.parse` can hand back, so the checks below read a value with a shape rather than `unknown`. */
type Json = string | number | boolean | null | readonly Json[] | JsonObject;
interface JsonObject {
    readonly [key: string]: Json | undefined;
}

const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const isList = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
const isText = (value: Json | undefined): value is string => typeof value === "string";

const bounded = (value: Json | undefined, max: number): string | undefined => (isText(value) && value !== "" && value.length <= max ? value : undefined);

/** A path of this site or the app: one leading slash, not a protocol-relative address. */
const pathOf = (value: Json | undefined): string | undefined => {
    const path = bounded(value, MAX_PATH);
    return path !== undefined && path.startsWith("/") && !path.startsWith("//") ? path : undefined;
};

const campaignFrom = (value: Json | undefined): Campaign => {
    const campaign: Campaign = {};
    if (!isObject(value)) {
        return campaign;
    }
    for (const key of CAMPAIGN_KEYS) {
        const tag = bounded(value[key], MAX_PARAM);
        if (tag !== undefined) {
            campaign[key] = tag;
        }
    }
    return campaign;
};

const checkedEvent = (item: Json): CheckedEvent | undefined => {
    if (!isObject(item) || !isText(item.event) || !EVENTS.has(item.event)) {
        return undefined;
    }
    const path = pathOf(item.path);
    if (path === undefined) {
        return undefined;
    }
    return {
        event: item.event,
        path,
        referrer: bounded(item.referrer, MAX_HOST),
        campaign: campaignFrom(item.campaign),
        cta: bounded(item.cta, MAX_CTA),
        target: pathOf(item.target),
    };
};

const parsedBody = (raw: string): Json | undefined => {
    try {
        // SAFETY: JSON.parse returns only the values the Json union names (strings, numbers, booleans, null, arrays, objects).
        return JSON.parse(raw) as Json;
    } catch {
        // allow(silent-catch): anyone can post here; a body that is not JSON is dropped like any other malformed one.
        return undefined;
    }
};

/** The events in a posted body that pass every check; anything malformed is dropped, not repaired. */
export const checkedEvents = (raw: string): CheckedEvent[] => {
    if (raw.length > MAX_BODY) {
        return [];
    }
    const body = parsedBody(raw);
    if (!isObject(body) || !isList(body.events)) {
        return [];
    }
    return body.events
        .slice(0, MAX_EVENTS)
        .map(checkedEvent)
        .filter((event): event is CheckedEvent => event !== undefined);
};

const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Today's anonymous id for this address and browser, or a fresh one per call when there is no salt. */
export const visitorId = async (salt: string | undefined, utcDay: string, address: string, userAgent: string): Promise<string> => {
    if (salt === undefined || salt === "") {
        return `site-${crypto.randomUUID()}`;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${utcDay}|${address}|${userAgent}`));
    return `site-${hex(digest).slice(0, 32)}`;
};

/** Every property an event from the site can carry, and nothing else. */
interface SiteEventProperties extends Campaign {
    readonly $lib: "intentic-site";
    readonly $process_person_profile: false;
    readonly $geoip_disable: true;
    readonly $host: string;
    readonly $current_url: string;
    readonly $pathname: string;
    readonly $referrer: string;
    readonly $referring_domain: string;
    $geoip_country_code?: string;
    cta?: string;
    target_path?: string;
}

const propertiesOf = (checked: CheckedEvent, siteOrigin: string, country: string | undefined): SiteEventProperties => {
    const properties: SiteEventProperties = {
        $lib: "intentic-site",
        $process_person_profile: false,
        $geoip_disable: true,
        $host: new URL(siteOrigin).host,
        $current_url: `${siteOrigin}${checked.path}`,
        $pathname: checked.path,
        $referrer: checked.referrer === undefined ? "$direct" : `https://${checked.referrer}/`,
        $referring_domain: checked.referrer ?? "$direct",
    };
    if (country !== undefined) {
        properties.$geoip_country_code = country;
    }
    for (const key of CAMPAIGN_KEYS) {
        const tag = checked.campaign[key];
        if (tag !== undefined) {
            properties[key] = tag;
        }
    }
    if (checked.cta !== undefined) {
        properties.cta = checked.cta;
    }
    if (checked.target !== undefined) {
        properties.target_path = checked.target;
    }
    return properties;
};

/** PostHog's batch body for these events, as one visitor in one country. */
export const posthogBatch = (key: string, siteOrigin: string, distinctId: string, country: string | undefined, events: readonly CheckedEvent[], now: Date) => ({
    api_key: key,
    batch: events.map((checked) => ({
        event: checked.event,
        distinct_id: distinctId,
        timestamp: now.toISOString(),
        properties: propertiesOf(checked, siteOrigin, country),
    })),
});

const NOTHING = (): Response => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** `POST /wire/site`: always 204, whatever happened, so a counter never shows on the page. */
export const handleSiteWire = async (request: Request, env: WireEnv, country: string | undefined, now: Date = new Date()): Promise<Response> => {
    if (request.method !== "POST" || env.POSTHOG_KEY === undefined || env.POSTHOG_KEY === "") {
        return NOTHING();
    }
    const events = checkedEvents(await request.text());
    if (events.length === 0) {
        return NOTHING();
    }
    const url = new URL(request.url);
    const address = request.headers.get("cf-connecting-ip") ?? "";
    const utcDay = now.toISOString().slice(0, 10);
    const id = await visitorId(env.WIRE_SALT, utcDay, address, request.headers.get("user-agent") ?? "");
    const host = env.POSTHOG_HOST ?? "https://us.i.posthog.com";
    try {
        await fetch(`${host}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(posthogBatch(env.POSTHOG_KEY, url.origin, id, country, events, now)),
        });
    } catch {
        // allow(silent-catch): a PostHog outage costs a count, never the page.
    }
    return NOTHING();
};
