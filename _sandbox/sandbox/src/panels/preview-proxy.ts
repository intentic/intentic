import http from "node:http";
import https from "node:https";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { escapeHtml, interstitial, type Refusal } from "./interstitial.js";
import type { PanelServer, PanelUpstreamResolver } from "./panel-upstream.js";

// Resolves a panel key to what its hostname actually serves right now: the assigned port when a dev server took
// it, the port the repo really bound when it pinned its own, the ambiguity when it bound several (see
// panel-upstream.ts, which owns that rule).
export type { PanelUpstreamResolver } from "./panel-upstream.js";
// Resolves a forward slot to its mapped port + upstream scheme, the port-forwards table's `targetOf`.
export type SlotResolver = (slot: string) => PortTarget | undefined;

/* THE ONE PATH THIS PROXY ANSWERS FOR ITSELF, and the only way a browser can find out whether a preview
 * hostname reaches this sandbox at all.
 *
 * A cross-origin `fetch` can't read a status without CORS, so the panel's old gate asked `no-cors` and took ANY
 * settled response as "reachable", which a Cloudflare 502 for an unrouted name satisfies. It then framed that
 * 502 — whose error page carries `X-Frame-Options`, so the user got the browser's bare "refused to connect" for
 * what was really "this sandbox has no preview address". This path answers with CORS open, so the browser can
 * tell the two apart: a readable 200 means the name reached THIS proxy, anything else means it did not.
 *
 * Reserved rather than negotiated: it is answered before the request is forwarded, so an app under preview
 * never sees it, and `__intentic` is a prefix no dev server routes. The browser half is
 * @intentic/ui's portPreview.ts, which hardcodes this same string. */
export const PREVIEW_PROBE_PATH = "/__intentic/preview-probe";

// What this proxy can answer for. `outbox` is absent on a sandbox with no connect token (tests, loopback), which
// has no salted slot to serve one at, publishing is a tunnel feature.
export interface PreviewProxyDeps {
    readonly panelOf: PanelUpstreamResolver;
    readonly slotTargetOf: SlotResolver;
    readonly sandboxId?: string | undefined;
    readonly outbox?: { readonly slot: string; readonly serve: PublicHandler } | undefined;
}

// What one request resolves to: an upstream to dial, the outbox's static handler, the proxy's own probe, or a
// terminal status. A panel on its ASSIGNED port keeps Host unchanged (a dev server the daemon started expects
// the preview hostname; the scaffolded templates allow it). Everything else, a forwarded port and a panel
// answering on a port it pinned itself, is an arbitrary user app whose framework host check only ever knew
// localhost, so Host AND Origin are rewritten to localhost:<port>. The target is identified by the port, never
// the vhost, so the rewrite loses nothing. `dial` is the loopback address the upstream actually answers at:
// panels bind 127.0.0.1, but a server that bound `localhost` can sit on ::1 only (Vite), the forward table
// records which.
type Resolved =
    | {
          readonly kind: "proxy";
          readonly dial: string;
          readonly port: number;
          readonly scheme: "http" | "https";
          readonly headers: http.IncomingHttpHeaders;
      }
    | { readonly kind: "outbox" }
    | { readonly kind: "probe"; readonly body: ProbeBody }
    | ({ readonly kind: "refused" } & Refusal);

// What the probe says. The state is this sandbox's own view of the address; the browser needs only that the
// answer was readable at all, but a person running `curl` on a preview hostname gets the whole diagnosis.
interface ProbeBody {
    readonly proxy: "intentic-preview";
    readonly target: "panel" | "port" | "outbox";
    readonly name?: string;
    readonly state: "serving" | "starting" | "several" | "stopped" | "unforwarded";
    readonly servers?: readonly PanelServer[];
}

// Rewrite Host + Origin at the door of an app that never agreed to be reached by its preview name.
const asLocalhost = (headers: http.IncomingHttpHeaders, target: PortTarget): http.IncomingHttpHeaders => {
    const localhost = `localhost:${target.port}`;
    const rewritten: http.IncomingHttpHeaders = { ...headers, host: localhost };
    if (headers.origin !== undefined) {
        rewritten.origin = `${target.scheme}://${localhost}`;
    }
    return rewritten;
};

const resolveRequest = async (req: http.IncomingMessage, deps: PreviewProxyDeps): Promise<Resolved> => {
    const probing = (req.url ?? "").split("?")[0] === PREVIEW_PROBE_PATH;
    const panel = panelFromHost(req.headers.host, deps.sandboxId);
    if (panel !== undefined) {
        const upstream = await deps.panelOf(panel);
        const name = escapeHtml(panel);
        if (probing) {
            return {
                kind: "probe",
                body: {
                    proxy: "intentic-preview",
                    target: "panel",
                    name: panel,
                    state: upstream.state,
                    ...(upstream.state === "several" ? { servers: upstream.servers } : {}),
                },
            };
        }
        if (upstream.state === "serving") {
            return upstream.assigned
                ? { kind: "proxy", dial: "127.0.0.1", port: upstream.port, scheme: "http", headers: req.headers }
                : {
                      kind: "proxy",
                      dial: "127.0.0.1",
                      port: upstream.port,
                      scheme: "http",
                      headers: asLocalhost(req.headers, { port: upstream.port, host: "127.0.0.1", scheme: "http" }),
                  };
        }
        if (upstream.state === "starting") {
            return {
                kind: "refused",
                status: 502,
                title: "Preview is starting",
                message: `"${name}" is starting and hasn't opened a port yet: its terminal in the sandbox shows how far it has got`,
            };
        }
        if (upstream.state === "several") {
            // Naming them IS the answer: one hostname cannot stand for three dev servers, and the user is the
            // only one who knows which of them they meant.
            const listed = upstream.servers.map((server) => escapeHtml(`${server.dir ?? name}:${server.port}`)).join(", ");
            return {
                kind: "refused",
                status: 502,
                title: "Several servers here",
                message: `"${name}" is running ${upstream.servers.length} dev servers on ports of their own (${listed}), so this one address can't stand for it: forward the one you want from the Ports view and preview that`,
            };
        }
        return {
            kind: "refused",
            status: 502,
            title: "Preview isn't running",
            message: `panel "${name}" is not running, start it from the ${name} entry in the sidebar`,
        };
    }
    const slot = portSlotFromHost(req.headers.host, deps.sandboxId);
    if (slot !== undefined) {
        const target = deps.slotTargetOf(slot);
        if (probing) {
            return { kind: "probe", body: { proxy: "intentic-preview", target: "port", state: target === undefined ? "unforwarded" : "serving" } };
        }
        if (target === undefined) {
            return {
                kind: "refused",
                status: 502,
                title: "Nothing forwarded here",
                message: `nothing is forwarded here, re-open the preview from the Ports view or the terminal link`,
            };
        }
        return { kind: "proxy", dial: target.host, port: target.port, scheme: target.scheme, headers: asLocalhost(req.headers, target) };
    }
    // The outbox: one salted slot per sandbox, so a host carrying any OTHER public- slot is a stray subdomain
    // the wildcard caught, not this sandbox's.
    if (deps.outbox !== undefined && publicSlotFromHost(req.headers.host, deps.sandboxId) === deps.outbox.slot) {
        return probing ? { kind: "probe", body: { proxy: "intentic-preview", target: "outbox", state: "serving" } } : { kind: "outbox" };
    }
    return { kind: "refused", status: 404, title: "No preview here", message: "This address isn't a live Intentic preview." };
};

// Dial the upstream, plain http for panels, and for forwarded ports whatever scheme the forward probe
// detected (a vite serving https on 47145 gets a TLS dial with verification off: the cert is self-signed and
// the socket never leaves the sandbox's own netns).
const dialUpstream = (upstream: Extract<Resolved, { kind: "proxy" }>, req: http.IncomingMessage): http.ClientRequest =>
    (upstream.scheme === "https" ? https : http).request({
        host: upstream.dial,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: upstream.headers,
        ...(upstream.scheme === "https" ? { rejectUnauthorized: false } : {}),
    });

// The preview reverse proxy: the Cloudflare tunnel routes preview hostnames to this one port (per-label
// ingress rules on the intentic-provided path, the whole `*.<zone>` wildcard on the own-Cloudflare path), and
// the Host header's first DNS label picks what answers, `preview-<panel>-<sandboxId>` → the panel's dev
// server, `port-<slot>-<sandboxId>` → the slot's forwarded port, `public-<slot>-<sandboxId>` → the workspace's
// outbox as static files (public/public-serve.ts). A non-preview host (a stray subdomain the wildcard also
// catches) → 404. Everything here is public, no auth in front of the proxy.
export const createPreviewProxy = (deps: PreviewProxyDeps): http.Server => {
    const server = http.createServer((req, res) => {
        void (async () => {
            const resolved = await resolveRequest(req, deps);
            if (resolved.kind === "probe") {
                // Readable cross-origin BY DESIGN: it carries no sandbox content, and being readable is the
                // entire point (see PREVIEW_PROBE_PATH). Never cached, the state it reports changes by the second.
                res.writeHead(200, {
                    "content-type": "application/json; charset=utf-8",
                    "access-control-allow-origin": "*",
                    "cache-control": "no-store",
                });
                res.end(JSON.stringify(resolved.body));
                return;
            }
            if (resolved.kind === "refused") {
                res.writeHead(resolved.status, { "content-type": "text/html; charset=utf-8" });
                res.end(interstitial(resolved.title, resolved.message));
                return;
            }
            if (resolved.kind === "outbox") {
                // The handler owns its own failures (a read error after the head destroys the socket); an unexpected
                // one still must not take the daemon down with it.
                void deps.outbox?.serve(req, res).catch(() => res.destroy());
                return;
            }
            const proxyReq = dialUpstream(resolved, req);
            proxyReq.on("response", (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                proxyRes.pipe(res);
            });
            proxyReq.on("error", () => {
                // Headers already sent means the upstream died mid-response, nothing useful left to say.
                if (res.headersSent) {
                    res.destroy();
                    return;
                }
                res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
                res.end(interstitial("Preview unavailable", `nothing is answering on port ${resolved.port}: the server may have stopped`));
            });
            req.pipe(proxyReq);
        })().catch(() => res.destroy());
    });

    // WebSocket upgrades (Vite/Astro HMR): replay the handshake upstream, echo the 101 back, then pipe raw
    // bytes both ways. The outbox is files, there is nothing on the other side to upgrade to.
    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => socket.destroy());
        void (async () => {
            const resolved = await resolveRequest(req, deps);
            if (resolved.kind === "refused") {
                socket.end(`HTTP/1.1 ${resolved.status} ${resolved.message}\r\n\r\n`);
                return;
            }
            if (resolved.kind === "outbox" || resolved.kind === "probe") {
                socket.end(`HTTP/1.1 404 Not Found\r\n\r\n`);
                return;
            }
            const proxyReq = dialUpstream(resolved, req);
            proxyReq.on("error", () => socket.destroy());
            proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
                const headerLines: string[] = [];
                for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
                    headerLines.push(`${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}`);
                }
                socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerLines.join("\r\n")}\r\n\r\n`);
                if (proxyHead.length > 0) {
                    socket.write(proxyHead);
                }
                if (head.length > 0) {
                    proxySocket.write(head);
                }
                proxySocket.on("error", () => socket.destroy());
                socket.on("error", () => proxySocket.destroy());
                proxySocket.pipe(socket);
                socket.pipe(proxySocket);
            });
            proxyReq.end();
        })().catch(() => socket.destroy());
    });

    return server;
};
