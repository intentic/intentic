import http from "node:http";
import { panelFromHost } from "@intentic/sandbox-contract";

// Resolves a repo name to the local port its running panel was assigned (undefined when not running) — the
// process manager's `portOf`, narrowed so the proxy needs nothing else.
export type PortResolver = (repo: string) => number | undefined;

// The preview reverse proxy: the Cloudflare tunnel routes preview hostnames to this one port (per-panel
// ingress rules on the intentic-provided path, the whole `*.<zone>` wildcard on the own-Cloudflare path), and
// the Host header's first DNS label picks the panel key — preview-<panel>-<sandboxId>.<zone> →
// 127.0.0.1:<panel port> (parsing rules in preview-hostname.ts). A non-preview host (a stray subdomain the
// wildcard also catches) → 404. The Host header is forwarded unchanged (dev servers that validate hosts, e.g.
// Vite's server.allowedHosts, must allow the preview hostname). A panel that isn't running has no port → 502
// "start it". Every preview is public — no auth in front of the proxy.
export const createPreviewProxy = (portOf: PortResolver, sandboxId?: string): http.Server => {
    const server = http.createServer((req, res) => {
        const repo = panelFromHost(req.headers.host, sandboxId);
        if (repo === undefined) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("not a preview host");
            return;
        }
        const port = portOf(repo);
        if (port === undefined) {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`panel "${repo}" is not running — start it from the ${repo} entry in the sidebar`);
            return;
        }
        const proxyReq = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on("error", () => {
            // Headers already sent means the panel died mid-response — nothing useful left to say.
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`panel "${repo}" is not answering on port ${port} — restart it from the sidebar`);
        });
        req.pipe(proxyReq);
    });

    // WebSocket upgrades (Vite/Astro HMR): replay the handshake upstream, echo the 101 back, then pipe raw
    // bytes both ways.
    server.on("upgrade", (req, socket, head) => {
        socket.on("error", () => socket.destroy());
        const repo = panelFromHost(req.headers.host, sandboxId);
        if (repo === undefined) {
            socket.end(`HTTP/1.1 404 Not Found\r\n\r\n`);
            return;
        }
        const port = portOf(repo);
        if (port === undefined) {
            socket.end(`HTTP/1.1 502 panel "${repo}" is not running\r\n\r\n`);
            return;
        }
        const proxyReq = http.request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: req.headers });
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
