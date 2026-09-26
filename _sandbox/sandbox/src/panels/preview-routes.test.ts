import http from "node:http";
import type { AddressInfo } from "node:net";
import type { PanelUpstream, PanelUpstreamResolver } from "./panel-upstream.js";
import { answerPreview, PREVIEW_PROBE_PATH, type PreviewDeps, previewRoute, type SlotResolver } from "./preview-routes.js";

// What becomes of a preview host's request, decided once when the front asks, and the two things it still hands back.
// The byte relay (Host/Origin rewrite, frame-ancestors, TLS and ::1 upstreams) is the front's, tested in _sandbox/front.

const ID = "abcdef012345";

const panelsOf =
    (table: Record<string, PanelUpstream>): PanelUpstreamResolver =>
    (key) =>
        Promise.resolve(table[key] ?? { state: "stopped" });
const noSlots: SlotResolver = () => undefined;
const slots: SlotResolver = (slot) => (slot === "a" ? { port: 5174, host: "127.0.0.1", scheme: "http" } : undefined);

interface DepsOverrides {
    readonly panelOf?: PanelUpstreamResolver;
    readonly slotTargetOf?: SlotResolver;
    readonly sandboxId?: string;
    readonly outbox?: PreviewDeps["outbox"];
}

const deps = ({ panelOf = panelsOf({}), slotTargetOf = noSlots, sandboxId, outbox }: DepsOverrides = {}): PreviewDeps => ({
    panelOf,
    slotTargetOf,
    sandboxId,
    outbox,
});

describe("previewRoute", () => {
    test("an assigned panel keeps the preview's Host; a self-pinned one is told it is localhost", async () => {
        const panelOf = panelsOf({ app: { state: "serving", port: 4000, assigned: true }, own: { state: "serving", port: 4001, assigned: false } });
        expect(await previewRoute("preview-app.example.com", false, deps({ panelOf }))).toEqual({
            to: "upstream",
            upstream: { host: "127.0.0.1", port: 4000, scheme: "http", localhost: false, frameable: true },
        });
        expect(await previewRoute("preview-own.example.com", false, deps({ panelOf }))).toEqual({
            to: "upstream",
            upstream: { host: "127.0.0.1", port: 4001, scheme: "http", localhost: true, frameable: true },
        });
    });

    test("a port slot relays to its target as it was probed: address, scheme, and a localhost Host", async () => {
        const targets: SlotResolver = (slot) => (slot === "a" ? { port: 8443, host: "::1", scheme: "https" } : undefined);
        expect(await previewRoute("port-a.example.com", false, deps({ slotTargetOf: targets }))).toEqual({
            to: "upstream",
            upstream: { host: "::1", port: 8443, scheme: "https", localhost: true, frameable: true },
        });
    });

    test("everything that is not a serving upstream is a page rendered now, so nothing is resolved twice", async () => {
        const panelOf = panelsOf({ app: { state: "starting" } });
        const status = async (host: string, previewDeps: PreviewDeps): Promise<[string, number | undefined]> => {
            const route = await previewRoute(host, false, previewDeps);
            return [route.to, route.to === "page" ? route.page.status : undefined];
        };
        expect(await status("preview-app.example.com", deps({ panelOf }))).toEqual(["page", 502]);
        expect(await status("preview-idle.example.com", deps())).toEqual(["page", 502]);
        expect(await status("port-b.example.com", deps({ slotTargetOf: slots }))).toEqual(["page", 502]);
        expect(await status("app.example.com", deps())).toEqual(["page", 404]);
    });

    test("with a sandbox id only its own suffix routes", async () => {
        const panelOf = panelsOf({ app: { state: "serving", port: 4000, assigned: true } });
        expect((await previewRoute(`preview-app-${ID}.example.com`, false, deps({ panelOf, sandboxId: ID }))).to).toBe("upstream");
        expect((await previewRoute("preview-app-000000000000.example.com", false, deps({ panelOf, sandboxId: ID }))).to).toBe("page");
        expect((await previewRoute("preview-app.example.com", false, deps({ panelOf, sandboxId: ID }))).to).toBe("page");
    });
});

describe("the pages the front writes as rendered", () => {
    // What the front is told to write for a host, as a browser would read it.
    const rendered = async (
        previewDeps: PreviewDeps,
        host: string,
        path = "/",
    ): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> => {
        const route = await previewRoute(host, path === PREVIEW_PROBE_PATH, previewDeps);
        if (route.to !== "page") {
            throw new Error(`${host}${path} routes to ${route.to}, not a page`);
        }
        return route.page;
    };

    test("a stray subdomain is a 404, and a panel that isn't running a 502 pointing at the sidebar", async () => {
        const port = deps();
        expect((await rendered(port, "app.example.com")).status).toBe(404);
        const idle = await rendered(port, "preview-desired-state.example.com");
        expect(idle.status).toBe(502);
        expect(idle.body).toContain(`panel "desired-state" is not running`);
    });

    test("an unmapped slot is a 502, not a 404: the hostname is ours, the forward just lapsed", async () => {
        const response = await rendered(deps({ slotTargetOf: slots }), "port-b.example.com");
        expect(response.status).toBe(502);
        expect(response.body).toContain("nothing is forwarded here");
    });

    test("a panel with several self-pinned servers names them, and one still starting says so", async () => {
        const panelOf = panelsOf({
            mono: {
                state: "several",
                servers: [
                    { port: 4321, dir: "_site/site" },
                    { port: 47145, dir: "_editor/web" },
                ],
            },
            app: { state: "starting" },
        });
        const port = deps({ panelOf });
        const several = await rendered(port, "preview-mono.example.com");
        expect(several.status).toBe(502);
        expect(several.body).toContain("_site/site:4321");
        expect(several.body).toContain("_editor/web:47145");
        const starting = await rendered(port, "preview-app.example.com");
        expect(starting.status).toBe(502);
        expect(starting.body).toContain("hasn't opened a port yet");
    });

    test("the probe answers with CORS open and the live state, and never names the port", async () => {
        const panelOf = panelsOf({ app: { state: "serving", port: 4000, assigned: true }, mono: { state: "several", servers: [{ port: 4321, dir: "_site/site" }] } });
        const port = deps({ panelOf, slotTargetOf: slots });
        const serving = await rendered(port, "preview-app.example.com", PREVIEW_PROBE_PATH);
        expect(serving.status).toBe(200);
        expect(serving.headers["access-control-allow-origin"]).toBe("*");
        expect(JSON.parse(serving.body)).toEqual({ proxy: "intentic-preview", target: "panel", name: "app", state: "serving" });
        expect(serving.body).not.toContain("4000");
        expect(JSON.parse((await rendered(port, "preview-mono.example.com", PREVIEW_PROBE_PATH)).body)).toMatchObject({
            state: "several",
            servers: [{ port: 4321, dir: "_site/site" }],
        });
        expect(JSON.parse((await rendered(port, "port-b.example.com", PREVIEW_PROBE_PATH)).body)).toEqual({ proxy: "intentic-preview", target: "port", state: "unforwarded" });
        const stray = await rendered(port, "app.example.com", PREVIEW_PROBE_PATH);
        expect(stray.status).toBe(404);
        expect(stray.headers["access-control-allow-origin"]).toBeUndefined();
    });

    test("the probe of a serving panel is its report, never a relay to the panel", async () => {
        const panelOf = panelsOf({ app: { state: "serving", port: 4000, assigned: true } });
        expect((await previewRoute("preview-app.example.com", true, deps({ panelOf }))).to).toBe("page");
    });
});

describe("answerPreview", () => {
    const servers: http.Server[] = [];
    afterAll(async () => {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    });

    // Node's HTTP side as the front reaches it: a request the front marked and handed back.
    const answering = async (previewDeps: PreviewDeps): Promise<number> => {
        const server = http.createServer((request, response) => void answerPreview(request, response, previewDeps));
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return (server.address() as AddressInfo).port;
    };

    const handBack = (
        port: number,
        host: string,
        path = "/",
        mark: Record<string, string> = { "x-intentic-preview": "outbox" },
    ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
        new Promise((resolve, reject) => {
            const request = http.request({ host: "127.0.0.1", port, path, headers: { host, ...mark } }, (response) => {
                let body = "";
                response.on("data", (chunk: Buffer) => {
                    body += chunk.toString();
                });
                response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
            });
            request.on("error", reject);
            request.end();
        });

    test("an upstream that refused the front's connection is a 502 naming its port", async () => {
        const response = await handBack(await answering(deps()), "port-a.example.com", "/", { "x-intentic-preview-unreachable": "5174" });
        expect(response.status).toBe(502);
        expect(response.body).toContain("nothing is answering on port 5174");
    });

    test("the outbox serves its own slot and nothing else under public-", async () => {
        const served: string[] = [];
        const outbox = {
            slot: "9f8e7d6c5b4a",
            serve: (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
                served.push(request.url ?? "");
                response.end("published");
                return Promise.resolve();
            },
        };
        const outboxDeps = deps({ outbox, sandboxId: ID });
        expect(await previewRoute(`public-9f8e7d6c5b4a-${ID}.example.com`, false, outboxDeps)).toEqual({ to: "outbox" });
        const stray = await previewRoute(`public-000000000000-${ID}.example.com`, false, outboxDeps);
        expect(stray.to === "page" ? stray.page.status : stray.to).toBe(404);
        // Handed back marked as the outbox it was decided to be, it is served without being resolved again.
        const port = await answering(outboxDeps);
        expect((await handBack(port, `public-9f8e7d6c5b4a-${ID}.example.com`, "/report.pdf")).body).toBe("published");
        expect((await handBack(port, `public-9f8e7d6c5b4a-${ID}.example.com`, "/report.pdf", { "x-intentic-preview": "answer" })).status).toBe(404);
        expect(served).toEqual(["/report.pdf"]);
    });
});
