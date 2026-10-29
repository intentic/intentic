import worker from "../../../worker";
import { LIVE_CONTENT_URL } from "../live";

test("assets bypass live content while pages and downloads share the pending read", async () => {
    const body = new TransformStream();
    const github = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body.readable));
    const page = '<div data-live-notice hidden><span data-live-notice-message>Built notice</span></div><a class="btn" href="https://app.intentic.dev/">Start</a>';
    const assets = jest.fn(async (input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
        if (path === "/docs") {
            return new Response(null, { status: 307, headers: { location: "/docs/" } });
        }
        if (path === "/missing.css") {
            return new Response(page, { status: 404, headers: { "content-type": "text/html" } });
        }
        const html = path.endsWith("/") || path.endsWith(".html");
        return new Response(html ? page : "asset", { headers: { "content-type": html ? "text/html" : "application/octet-stream" } });
    });
    const env = { ASSETS: { fetch: Object.assign(assets, { preconnect: fetch.preconnect }) } };
    const request = (path: string) => worker.fetch(new Request(`https://intentic.dev${path}`), env);

    try {
        for (const path of ["/_astro/site.css", "/_astro/site.js", "/assets/plate/temple-900.avif", "/fonts/lora.woff2", "/facts.md", "/robots.txt", "/demo/", "/connect", "/update/sandbox-abc"]) {
            expect((await request(path)).status).toBe(200);
        }
        for (const [path, location] of [["/sitemap.xml", "/sitemap-index.xml"], ["/product/run/", "/features/run/"], ["/docs", "/docs/"]]) {
            const response = await request(path!);
            expect(response.status).toBe(301);
            expect(response.headers.get("location")).toBe(`https://intentic.dev${location}`);
        }
        expect(github).toHaveBeenCalledTimes(0);

        const documents = [request("/"), request("/docs/"), request("/missing.css")];
        const download = request("/desktop/windows");
        let servedPage = false;
        let servedDownload = false;
        void documents[0]!.then(() => { servedPage = true; });
        void download.then(() => { servedDownload = true; });

        // These finish even though the live document's body has not arrived.
        expect(await (await request("/_astro/site.css")).text()).toBe("asset");
        expect((await request("/demo/")).status).toBe(200);
        expect(github).toHaveBeenCalledTimes(1);
        expect(github.mock.calls[0]?.[0]).toBe(LIVE_CONTENT_URL);
        expect(servedPage).toBe(false);
        expect(servedDownload).toBe(false);

        const writer = body.writable.getWriter();
        await writer.write(new TextEncoder().encode(JSON.stringify({
            notice: { active: true, message: "Live & current" },
            switches: { download: { enabled: false }, workspace: { enabled: false, reason: "Maintenance" } },
        })));
        await writer.close();

        for (const response of await Promise.all(documents)) {
            const html = await response.text();
            expect(html).toContain("Live &amp; current");
            expect(html).toContain('aria-disabled="true"');
            expect(html).not.toContain('href="https://app.intentic.dev/"');
            expect(html).not.toContain(" hidden");
            expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
        }
        const blocked = await download;
        expect(blocked.status).toBe(302);
        expect(blocked.headers.get("location")).toBe("https://intentic.dev/download/");
        expect(assets.mock.calls.some(([input]) => String(input instanceof Request ? input.url : input).endsWith("/desktop/Intentic-setup.exe"))).toBe(false);
        expect(github).toHaveBeenCalledTimes(1);
    } finally {
        github.mockRestore();
    }
});
