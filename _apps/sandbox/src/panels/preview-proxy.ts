import http from "node:http";
import https from "node:https";
import { panelFromHost, portSlotFromHost } from "@intentic/sandbox-contract";
import type { PortTarget } from "../ports/port-forwards.js";

// Resolves a repo name to the local port its running panel was assigned (undefined when not running) — the
// process manager's `portOf`, narrowed so the proxy needs nothing else.
export type PortResolver = (repo: string) => number | undefined;
// Resolves a forward slot to its mapped port + upstream scheme — the port-forwards table's `targetOf`.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// What one request resolves to: an upstream to dial, or a terminal status. Panels forward Host unchanged (the
// scaffolded dev servers allow the preview hostname); forwarded ports rewrite Host AND Origin to
// localhost:<port> — those are arbitrary user apps, and stock Vite/webpack host checks reject any hostname
// they weren't configured for, so the rewrite is what makes an unmodified dev server just work. The target is
// identified by the port, never the vhost, so the rewrite loses nothing.
type Upstream = { port: number; scheme: "http" | "https"; headers: http.IncomingHttpHeaders } | { status: number; message: string };

const resolveUpstream = (req: http.IncomingMessage, portOf: PortResolver, slotTargetOf: SlotResolver, sandboxId: string | undefined): Upstream => {
    const repo = panelFromHost(req.headers.host, sandboxId);
    if (repo !== undefined) {
        const port = portOf(repo);
        if (port === undefined) {
            return { status: 502, message: `panel "${repo}" is not running — start it from the ${repo} entry in the sidebar` };
        }
        return { port, scheme: "http", headers: req.headers };
    }
    const slot = portSlotFromHost(req.headers.host, sandboxId);
    if (slot !== undefined) {
        const target = slotTargetOf(slot);
        if (target === undefined) {
            return { status: 502, message: `nothing is forwarded here — re-open the preview from the Ports view or the terminal link` };
        }
        const localhost = `localhost:${target.port}`;
        const headers: http.IncomingHttpHeaders = { ...req.headers, host: localhost };
        if (req.headers.origin !== undefined) {
            headers.origin = `${target.scheme}://${localhost}`;
        }
        return { port: target.port, scheme: target.scheme, headers };
    }
    return { status: 404, message: "not a preview host" };
};

// Dial the upstream — plain http for panels, and for forwarded ports whatever scheme the forward probe
// detected (a vite serving https on 47145 gets a TLS dial with verification off: the cert is self-signed and
// the socket never leaves the sandbox's own netns).
const dialUpstream = (
    upstream: { port: number; scheme: "http" | "https"; headers: http.IncomingHttpHeaders },
    req: http.IncomingMessage,
): http.ClientRequest =>
    (upstream.scheme === "https" ? https : http).request({
        host: "127.0.0.1",
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: upstream.headers,
        ...(upstream.scheme === "https" ? { rejectUnauthorized: false } : {}),
    });

// The preview reverse proxy: the Cloudflare tunnel routes preview hostnames to this one port (per-label
// ingress rules on the intentic-provided path, the whole `*.<zone>` wildcard on the own-Cloudflare path), and
// the Host header's first DNS label picks the upstream — `preview-<panel>-<sandboxId>` → the panel's dev
// server, `port-<slot>-<sandboxId>` → the slot's forwarded port (parsing in hostnames.ts). A non-preview host
// (a stray subdomain the wildcard also catches) → 404. Every preview is public — no auth in front of the proxy.
export const createPreviewProxy = (portOf: PortResolver, slotTargetOf: SlotResolver, sandboxId?: string): http.Server => {
    const server = http.createServer((req, res) => {
        const upstream = resolveUpstream(req, portOf, slotTargetOf, sandboxId);
        if ("status" in upstream) {
            res.writeHead(upstream.status, { "content-type": "text/plain" });
            res.end(upstream.message);
            return;
        }
        const proxyReq = dialUpstream(upstream, req);
        proxyReq.on("response", (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on("error", () => {
            // Headers already sent means the upstream died mid-response — nothing useful left to say.
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`nothing is answering on port ${upstream.port} — the server may have stopped`);
        });
        req.pipe(proxyReq);
    });

    // WebSocket upgrades (Vite/Astro HMR): replay the handshake upstream, echo the 101 back, then pipe raw
    // bytes both ways.
    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => socket.destroy());
        const upstream = resolveUpstream(req, portOf, slotTargetOf, sandboxId);
        if ("status" in upstream) {
            socket.end(`HTTP/1.1 ${upstream.status} ${upstream.message}\r\n\r\n`);
            return;
        }
        const proxyReq = dialUpstream(upstream, req);
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
