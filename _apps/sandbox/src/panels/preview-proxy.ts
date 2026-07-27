import http from "node:http";
import https from "node:https";
import { panelFromHost, portSlotFromHost } from "@intentic/sandbox-contract";
import type { PortTarget } from "../ports/port-forwards.js";

// Where the interstitial's CTA sends a viewer who just opened someone's shared preview — the "invite" half of the
// share loop (the "demo" half is the working preview itself). A shared preview is a live demo of an app built on
// Intentic; these status pages are the ONLY surface Intentic controls end-to-end (they are served by this proxy,
// never injected into the user's running app), so the attribution lives here and nowhere intrusive.
const INTENTIC_URL = "https://intentic.dev";

// Only the dynamic bits of a status message (a repo/slot name derived from the attacker-controllable Host) are
// escaped before landing in HTML; the static sentence around them is author-controlled. DNS labels are already a
// safe charset, so this is defense-in-depth.
const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

// A small, self-contained branded page for the proxy's own status responses (panel not up, nothing forwarded, dead
// upstream, stray host). Inline everything — this bare http server ships no assets. `message` is embedded as text
// content (its only dynamic parts are pre-escaped at the call site; literal quotes stay literal, which the proxy
// tests rely on). Shown at exactly the high-intent moment a viewer clicks a shared link before the server is up.
const interstitial = (title: string, message: string): string =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:26rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}p{margin:0;color:#9aa0a6}a.cta{display:inline-block;margin-top:1.5rem;padding-top:1.2rem;border-top:1px solid #1e2227;color:#8ab4f8;text-decoration:none;font-size:.8rem}a.cta:hover{text-decoration:underline}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p><a class="cta" href="${INTENTIC_URL}" target="_blank" rel="noopener">Preview powered by <b>Intentic</b> — build &amp; share your own →</a></div></body></html>`;

// Resolves a repo name to the local port its running panel was assigned (undefined when not running) — the
// process manager's `portOf`, narrowed so the proxy needs nothing else.
export type PortResolver = (repo: string) => number | undefined;
// Resolves a forward slot to its mapped port + upstream scheme — the port-forwards table's `targetOf`.
export type SlotResolver = (slot: string) => PortTarget | undefined;

// What one request resolves to: an upstream to dial, or a terminal status. Panels forward Host unchanged (the
// scaffolded dev servers allow the preview hostname); forwarded ports rewrite Host AND Origin to
// localhost:<port> — those are arbitrary user apps, and stock Vite/webpack host checks reject any hostname
// they weren't configured for, so the rewrite is what makes an unmodified dev server just work. The target is
// identified by the port, never the vhost, so the rewrite loses nothing. `dial` is the loopback address the
// upstream actually answers at: panels bind the daemon-assigned PORT on 127.0.0.1, but a forwarded server that
// bound `localhost` can sit on ::1 only (Vite) — the forward table records which.
type Upstream =
    { dial: string; port: number; scheme: "http" | "https"; headers: http.IncomingHttpHeaders } | { status: number; title: string; message: string };

const resolveUpstream = (req: http.IncomingMessage, portOf: PortResolver, slotTargetOf: SlotResolver, sandboxId: string | undefined): Upstream => {
    const repo = panelFromHost(req.headers.host, sandboxId);
    if (repo !== undefined) {
        const port = portOf(repo);
        if (port === undefined) {
            const name = escapeHtml(repo);
            return {
                status: 502,
                title: "Preview isn't running",
                message: `panel "${name}" is not running — start it from the ${name} entry in the sidebar`,
            };
        }
        return { dial: "127.0.0.1", port, scheme: "http", headers: req.headers };
    }
    const slot = portSlotFromHost(req.headers.host, sandboxId);
    if (slot !== undefined) {
        const target = slotTargetOf(slot);
        if (target === undefined) {
            return {
                status: 502,
                title: "Nothing forwarded here",
                message: `nothing is forwarded here — re-open the preview from the Ports view or the terminal link`,
            };
        }
        const localhost = `localhost:${target.port}`;
        const headers: http.IncomingHttpHeaders = { ...req.headers, host: localhost };
        if (req.headers.origin !== undefined) {
            headers.origin = `${target.scheme}://${localhost}`;
        }
        return { dial: target.host, port: target.port, scheme: target.scheme, headers };
    }
    return { status: 404, title: "No preview here", message: "This address isn't a live Intentic preview." };
};

// Dial the upstream — plain http for panels, and for forwarded ports whatever scheme the forward probe
// detected (a vite serving https on 47145 gets a TLS dial with verification off: the cert is self-signed and
// the socket never leaves the sandbox's own netns).
const dialUpstream = (
    upstream: { dial: string; port: number; scheme: "http" | "https"; headers: http.IncomingHttpHeaders },
    req: http.IncomingMessage,
): http.ClientRequest =>
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
// the Host header's first DNS label picks the upstream — `preview-<panel>-<sandboxId>` → the panel's dev
// server, `port-<slot>-<sandboxId>` → the slot's forwarded port (parsing in hostnames.ts). A non-preview host
// (a stray subdomain the wildcard also catches) → 404. Every preview is public — no auth in front of the proxy.
export const createPreviewProxy = (portOf: PortResolver, slotTargetOf: SlotResolver, sandboxId?: string): http.Server => {
    const server = http.createServer((req, res) => {
        const upstream = resolveUpstream(req, portOf, slotTargetOf, sandboxId);
        if ("status" in upstream) {
            res.writeHead(upstream.status, { "content-type": "text/html; charset=utf-8" });
            res.end(interstitial(upstream.title, upstream.message));
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
            res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
            res.end(interstitial("Preview unavailable", `nothing is answering on port ${upstream.port} — the server may have stopped`));
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
