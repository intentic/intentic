import { createLiveContentResolver } from "./live-resolver";
import { LIVE_CACHE_SECONDS, LIVE_CONTENT_URL } from "../live";

describe("live content cache", () => {
    test("shares cold and expired reads, and starts the TTL after the body is parsed", async () => {
        let clock = 0;
        const ttl = LIVE_CACHE_SECONDS * 1000;
        const body = new TransformStream();
        const fetchImpl = jest.fn(() => Promise.resolve(new Response(body.readable)));
        const liveContent = createLiveContentResolver(fetchImpl, () => clock);
        const first = liveContent();
        const second = liveContent();
        const writer = body.writable.getWriter();
        await writer.write(new TextEncoder().encode(JSON.stringify({ notice: { active: true, message: "First notice" } })));
        // The response headers arrived, but its body is still being read.
        const third = liveContent();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledWith(LIVE_CONTENT_URL, { cf: { cacheTtl: LIVE_CACHE_SECONDS, cacheEverything: true } });
        clock = ttl;
        await writer.close();
        const content = await first;
        expect(content?.notice.message).toBe("First notice");
        expect(await second).toBe(content);
        expect(await third).toBe(content);

        clock = 2 * ttl - 1;
        expect(await liveContent()).toBe(content);
        expect(fetchImpl).toHaveBeenCalledTimes(1);

        fetchImpl.mockImplementation(() => Promise.resolve(Response.json({ switches: { download: { enabled: false, reason: "Maintenance" } } })));
        clock = 2 * ttl;
        const refreshed = await Promise.all([liveContent(), liveContent(), liveContent()]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(refreshed[0]?.switches.download).toEqual({ enabled: false, reason: "Maintenance" });
        expect(refreshed[1]).toBe(refreshed[0]);
        expect(refreshed[2]).toBe(refreshed[0]);
    });

    test.each(["network", "status", "json", "shape"])("caches a %s failure and retries at the refresh boundary", async (failure) => {
        let clock = 0;
        const fetchImpl = jest.fn(async () => {
            if (failure === "network") {
                throw new Error("offline");
            }
            if (failure === "status") {
                return new Response(null, { status: 503 });
            }
            return failure === "json" ? new Response("not json") : Response.json(null);
        });
        const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
        try {
            const liveContent = createLiveContentResolver(fetchImpl, () => clock);
            expect(await Promise.all([liveContent(), liveContent()])).toEqual([undefined, undefined]);
            clock = LIVE_CACHE_SECONDS * 1000 - 1;
            expect(await liveContent()).toBeUndefined();
            expect(fetchImpl).toHaveBeenCalledTimes(1);

            fetchImpl.mockImplementation(() => Promise.resolve(Response.json({})));
            clock++;
            expect((await liveContent())?.switches.download.enabled).toBe(true);
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });
});
