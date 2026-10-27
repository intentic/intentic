import { json, type DemoHandler } from "../../transport";
import { panelAt } from "../extensions/panelRuns";
import { appAt } from "./apps";
import { sitePage } from "./appPage";

// The sandbox's preview proxy: the hostnames it serves started dev servers on (`preview-<repo>-<sandbox>.<zone>`,
// `preview-<repo>--<app>-<sandbox>.<zone>`), which the Preview tab probes and then frames. The probe's reserved path
// answers what the proxy knows (serving, starting, stopped), CORS-open as the daemon's is; once a server answers, its
// page is the storefront it serves. Reached by fetch for the probe, and by the frame through the demo's element worker.

// The proxy's reserved path (the daemon's PREVIEW_PROBE_PATH).
const PROBE_PATH = `/__intentic/preview-probe`;

const isPreviewHost = (url: URL): boolean => url.hostname.startsWith(`preview-`) && url.hostname.endsWith(`.demo.invalid`);

const answer = (url: URL): Response => {
    const app = appAt(url.host);
    const panel = app === undefined ? panelAt(url.host) : undefined;
    const known = app ?? panel;
    const state = known === undefined ? `stopped` : known.serving ? `serving` : `starting`;
    if (url.pathname === PROBE_PATH) {
        return new Response(JSON.stringify({ proxy: `intentic-preview`, state, servers: [] }), {
            status: 200,
            headers: { "content-type": `application/json`, "access-control-allow-origin": `*`, "cache-control": `no-store` },
        });
    }
    if (known === undefined || !known.serving) {
        return json({ error: `nothing is serving at this address yet` }, 502);
    }
    if (url.pathname !== `/` && url.pathname !== `/index.html`) {
        return new Response(`Cannot GET ${url.pathname}`, { status: 404, headers: { "content-type": `text/plain; charset=utf-8` } });
    }
    return new Response(sitePage(known.repo, app?.app), { status: 200, headers: { "content-type": `text/html; charset=utf-8` } });
};

/** The sandbox's handler with its preview proxy in front: a preview host is the proxy's, everything else the daemon's. */
export const withPreviewSites =
    (daemon: DemoHandler): DemoHandler =>
    (request, url) =>
        isPreviewHost(url) ? Promise.resolve(answer(url)) : daemon(request, url);
