import http from "node:http";
import https from "node:https";
import { panelFromHost, portSlotFromHost, publicSlotFromHost, sandboxSubdomain } from "@intentic/sandbox-contract";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { escapeHtml, interstitial, type Refusal } from "./interstitial.js";
import type { PanelServer, PanelUpstreamResolver } from "./panel-upstream.js";

// Resolves a panel key to what its hostname actually serves: the assigned port, a self-pinned port, or the ambiguity
// when it bound several.
export type { PanelUpstreamResolver } from "./panel-upstream.js";
// Resolves a forward slot to its mapped port and upstream scheme.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// CORS-open so a browser can tell reachable from not; the string must match @intentic/ui's portPreview.ts.
export const PREVIEW_PROBE_PATH = "/__intentic/preview-probe";

// What this proxy can answer for. `outbox` is absent without a connect token (tests, loopback), which has no salted
// slot to publish at.
export interface PreviewProxyDeps {
    readonly panelOf: PanelUpstreamResolver;
    readonly slotTargetOf: SlotResolver;
    readonly sandboxId?: string | undefined;
    readonly outbox?: { readonly slot: string; readonly serve: PublicHandler } | undefined;
    // Daemon's own port; undefined means no daemon route here (the loopback lanes reach it directly).
    readonly daemonPort?: number | undefined;
}

// What a request resolves to. An assigned-port panel keeps Host as-is; a forwarded port or self-pinned panel rewrites
// Host/Origin to localhost. `dial` is the loopback address the upstream actually answers at.
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

// What the probe reports: the sandbox's own view of the address. A browser only needs a readable response; curl gets
// the full diagnosis.
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

// Leftmost DNS label of a Host header; the only part routing here reads.
const labelOf = (host: string | undefined): string => host?.split(":")[0]?.split(".")[0] ?? "";

// Separate from `resolveRequest`'s rules since it asks whether a preview was meant at all; undefined means "not the
// daemon", never "unavailable". Host stays untouched: the daemon gates on its own origin.
const daemonUpstream = (req: http.IncomingMessage, deps: PreviewProxyDeps): Resolved | undefined => {
    const { daemonPort, sandboxId } = deps;
    if (daemonPort === undefined || sandboxId === undefined || sandboxId === "") {
        return undefined;
    }
    if (labelOf(req.headers.host) !== sandboxSubdomain(sandboxId)) {
        return undefined;
    }
    return { kind: "proxy", dial: "127.0.0.1", port: daemonPort, scheme: "http", headers: req.headers };
};

// The only rule whose answer depends on something the user started; kept out of `resolveRequest` so that stays a plain
// list of address kinds.
const panelUpstream = async (req: http.IncomingMessage, deps: PreviewProxyDeps, panel: string, probing: boolean): Promise<Resolved> => {
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
        // Naming them is the answer: one hostname can't stand for several servers; only the user knows which one.
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
};

const resolveRequest = async (req: http.IncomingMessage, deps: PreviewProxyDeps): Promise<Resolved> => {
    const probing = (req.url ?? "").split("?")[0] === PREVIEW_PROBE_PATH;
    const daemon = daemonUpstream(req, deps);
    if (daemon !== undefined) {
        return daemon;
    }
    const panel = panelFromHost(req.headers.host, deps.sandboxId);
    if (panel !== undefined) {
        return panelUpstream(req, deps, panel, probing);
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
    // One salted outbox slot per sandbox; any other public- slot is a stray subdomain the wildcard caught.
    if (deps.outbox !== undefined && publicSlotFromHost(req.headers.host, deps.sandboxId) === deps.outbox.slot) {
        return probing ? { kind: "probe", body: { proxy: "intentic-preview", target: "outbox", state: "serving" } } : { kind: "outbox" };
    }
    return { kind: "refused", status: 404, title: "No preview here", message: "This address isn't a live Intentic preview." };
};

// Dials plain http for panels; a forwarded port uses whatever scheme the forward probe detected, with TLS verification
// off since the cert is self-signed and the socket stays inside the sandbox's own netns.
const dialUpstream = (upstream: Extract<Resolved, { kind: "proxy" }>, req: http.IncomingMessage): http.ClientRequest =>
    (upstream.scheme === "https" ? https : http).request({
        host: upstream.dial,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: upstream.headers,
        ...(upstream.scheme === "https" ? { rejectUnauthorized: false } : {}),
    });

// The container's front door: the Host header's first DNS label picks the answer.
// - `sandbox-<sandboxId>` → the daemon, Host untouched
// - `preview-<panel>-<sandboxId>` → the panel's dev server
// - `port-<slot>-<sandboxId>` → the slot's forwarded port
// - `public-<slot>-<sandboxId>` → the workspace's outbox
// Anything else → 404. Previews are public, with no auth in front; the daemon route still gates itself past this hop.
export const createPreviewProxy = (deps: PreviewProxyDeps): http.Server => {
    const server = http.createServer((req, res) => {
        void (async () => {
            const resolved = await resolveRequest(req, deps);
            if (resolved.kind === "probe") {
                // Cross-origin readable by design; carries no sandbox content, never cached since state changes by the
                // second.
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
                // Handler owns its own failures; an unexpected one still must not take the daemon down with it.
                void deps.outbox?.serve(req, res).catch(() => res.destroy());
                return;
            }
            const proxyReq = dialUpstream(resolved, req);
            proxyReq.on("response", (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                proxyRes.pipe(res);
            });
            proxyReq.on("error", () => {
                // Headers already sent: the upstream died mid-response, nothing useful left to say.
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

    // WebSocket upgrades: replay the handshake upstream, echo the 101, then pipe raw bytes; the outbox has nothing to
    // upgrade to.
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
