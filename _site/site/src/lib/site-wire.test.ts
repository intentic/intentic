import { checkedEvents, handleSiteWire, posthogBatch, visitorId } from "./site-wire";

const body = (events: unknown[]): string => JSON.stringify({ events });

describe("checkedEvents", () => {
    it("keeps the two known events with their checked fields", () => {
        const [view, press] = checkedEvents(
            body([
                { event: "$pageview", path: "/pricing/", referrer: "news.ycombinator.com", campaign: { utm_source: "hn", evil: "x" } },
                { event: "site_cta_clicked", path: "/", campaign: {}, cta: "Start free", target: "/setup" },
            ]),
        );
        expect(view).toEqual({ event: "$pageview", path: "/pricing/", referrer: "news.ycombinator.com", campaign: { utm_source: "hn" }, cta: undefined, target: undefined });
        expect(press?.target).toBe("/setup");
    });

    it("drops anything else: unknown events, bad paths, oversized fields, a body that is not JSON", () => {
        expect(checkedEvents(body([{ event: "$identify", path: "/" }]))).toEqual([]);
        expect(checkedEvents(body([{ event: "$pageview", path: "//evil.example/" }]))).toEqual([]);
        expect(checkedEvents(body([{ event: "$pageview", path: `/${"a".repeat(400)}` }]))).toEqual([]);
        expect(checkedEvents("{not json")).toEqual([]);
        expect(checkedEvents("x".repeat(9000))).toEqual([]);
    });
});

describe("visitorId", () => {
    it("is the same for one address and browser within a day, and different the next day", async () => {
        const today = await visitorId("salt", "2026-10-15", "203.0.113.7", "UA");
        expect(await visitorId("salt", "2026-10-15", "203.0.113.7", "UA")).toBe(today);
        expect(await visitorId("salt", "2026-10-16", "203.0.113.7", "UA")).not.toBe(today);
        expect(today).not.toContain("203.0.113.7");
    });

    it("links nothing without a salt", async () => {
        expect(await visitorId(undefined, "2026-10-15", "203.0.113.7", "UA")).not.toBe(await visitorId(undefined, "2026-10-15", "203.0.113.7", "UA"));
    });
});

describe("posthogBatch", () => {
    it("sends a country instead of an address, no person profile, and the campaign tags", () => {
        const [event] = checkedEvents(body([{ event: "$pageview", path: "/", campaign: { utm_source: "hn" } }]));
        const sent = posthogBatch("phc_x", "https://intentic.dev", "site-1", "PL", [event!], new Date("2026-10-15T12:00:00Z"));
        expect(sent.batch[0]?.properties).toEqual(
            expect.objectContaining({ $process_person_profile: false, $geoip_disable: true, $geoip_country_code: "PL", $referrer: "$direct", utm_source: "hn" }),
        );
        expect(JSON.stringify(sent)).not.toContain("$ip");
    });
});

describe("handleSiteWire", () => {
    const post = (text: string): Request => new Request("https://intentic.dev/wire/site", { method: "POST", body: text, headers: { "cf-connecting-ip": "203.0.113.7" } });

    it("sends nothing without a key, and always answers 204", async () => {
        const calls: string[] = [];
        const original = globalThis.fetch;
        // SAFETY: the stand-in answers every call the handler makes (one POST) with what fetch would resolve to.
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls.push(String(input));
            return new Response(null, { status: 200 });
        }) as typeof fetch;
        try {
            const valid = body([{ event: "$pageview", path: "/", campaign: {} }]);
            expect((await handleSiteWire(post(valid), {}, undefined)).status).toBe(204);
            expect(calls).toEqual([]);
            expect((await handleSiteWire(post(valid), { POSTHOG_KEY: "phc_x", WIRE_SALT: "s" }, "PL")).status).toBe(204);
            expect(calls).toEqual(["https://us.i.posthog.com/batch/"]);
        } finally {
            globalThis.fetch = original;
        }
    });
});
