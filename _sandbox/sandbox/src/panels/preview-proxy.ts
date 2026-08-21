import http from "node:http";
import https from "node:https";
import { panelFromHost, portSlotFromHost, publicSlotFromHost } from "@intentic/sandbox-contract";
import type { PortTarget } from "../ports/port-forwards.js";
import type { PublicHandler } from "../public/public-serve.js";
import { escapeHtml, interstitial, type Refusal } from "./interstitial.js";

// Resolves a repo name to the local port its running panel was assigned (undefined when not running), the
// process manager's `portOf`, narrowed so the proxy needs nothing else.
export type PortResolver = (repo: string) => number | undefined;
// Resolves a forward slot to its mapped port + upstream scheme, the port-forwards table's `targetOf`.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// What this proxy can answer for. `outbox` is absent on a sandbox with no connect token (tests, loopback), which
// has no salted slot to serve one at, publishing is a tunnel feature.
export interface PreviewProxyDeps {
    readonly portOf: PortResolver;
    readonly slotTargetOf: SlotResolver;
    readonly sandboxId?: string | undefined;
    readonly outbox?: { readonly slot: string; readonly serve: PublicHandler } | undefined;
}

// What one request resolves to: an upstream to dial, the outbox's static handler, or a terminal status. Panels
// forward Host unchanged (the scaffolded dev servers allow the preview hostname); forwarded ports rewrite Host
// AND Origin to localhost:<port>, those are arbitrary user apps, and stock Vite/webpack host checks reject any
// hostname they weren't configured for, so the rewrite is what makes an unmodified dev server just work. The
// target is identified by the port, never the vhost, so the rewrite loses nothing. `dial` is the loopback
// address the upstream actually answers at: panels bind the daemon-assigned PORT on 127.0.0.1, but a forwarded
// server that bound `localhost` can sit on ::1 only (Vite), the forward table records which.
type Resolved =
    | {
          readonly kind: "proxy";
          readonly dial: string;
          readonly port: number;
          readonly scheme: "http" | "https";
          readonly headers: http.IncomingHttpHeaders;
      }
    | { readonly kind: "outbox" }
    | ({ readonly kind: "refused" } & Refusal);

const resolveRequest = (req: http.IncomingMessage, deps: PreviewProxyDeps): Resolved => {
    const repo = panelFromHost(req.headers.host, deps.sandboxId);
    if (repo !== undefined) {
        const port = deps.portOf(repo);
        if (port === undefined) {
            const name = escapeHtml(repo);
            return {
                kind: "refused",
                status: 502,
                title: "Preview isn't running",
                message: `panel "${name}" is not running, start it from the ${name} entry in the sidebar`,
            };
        }
        return { kind: "proxy", dial: "127.0.0.1", port, scheme: "http", headers: req.headers };
    }
    const slot = portSlotFromHost(req.headers.host, deps.sandboxId);
    if (slot !== undefined) {
        const target = deps.slotTargetOf(slot);
        if (target === undefined) {
            return {
                kind: "refused",
                status: 502,
                title: "Nothing forwarded here",
                message: `nothing is forwarded here, re-open the preview from the Ports view or the terminal link`,
            };
        }
        const localhost = `localhost:${target.port}`;
        const headers: http.IncomingHttpHeaders = { ...req.headers, host: localhost };
        if (req.headers.origin !== undefined) {
            headers.origin = `${target.scheme}://${localhost}`;
        }
        return { kind: "proxy", dial: target.host, port: target.port, scheme: target.scheme, headers };
    }
    // The outbox: one salted slot per sandbox, so a host carrying any OTHER public- slot is a stray subdomain
    // the wildcard caught, not this sandbox's.
    if (deps.outbox !== undefined && publicSlotFromHost(req.headers.host, deps.sandboxId) === deps.outbox.slot) {
        return { kind: "outbox" };
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
        const resolved = resolveRequest(req, deps);
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
    });

    // WebSocket upgrades (Vite/Astro HMR): replay the handshake upstream, echo the 101 back, then pipe raw
    // bytes both ways. The outbox is files, there is nothing on the other side to upgrade to.
    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => socket.destroy());
        const resolved = resolveRequest(req, deps);
        if (resolved.kind === "refused") {
            socket.end(`HTTP/1.1 ${resolved.status} ${resolved.message}\r\n\r\n`);
            return;
        }
        if (resolved.kind === "outbox") {
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
    });

    return server;
};
