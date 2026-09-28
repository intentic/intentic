import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { LoopbackCatch, LoopbackCatchEvent } from "@intentic/sandbox-contract";

// A sign-in's loopback redirect, caught on this machine (schemas/loopback-catch.ts in the contract). The provider sends
// the browser to http://localhost:<port>/<path>?code=…&state=…, the address a CLI running here would have listened on;
// this listens there instead, for the attempt's lifetime only, and hands every landing back up the stream. It checks
// nothing: the state and the PKCE verifier live in the sandbox, which alone can tell the sign-in from anything else on
// this machine that happens to hit the port. Loopback only, so nothing off this machine can reach it.

// However far away a sandbox asks it to watch until, a forgotten catch never holds a port longer than this.
const LONGEST_WATCH_MS = 30 * 60_000;

const escapeHtml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

// What the tab shows once it lands: the sign-in is finishing in the sandbox, so the tab has nothing left to do.
const landedPage = (title: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in to ${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e6e6}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#a0a4ab}</style>
</head><body><main><h1>Signed in to ${escapeHtml(title)}</h1><p>Intentic is finishing the connection. You can close this tab and go back to it.</p></main></body></html>`;

// Binds one address; false with the reason when it cannot, never a throw, so a taken port is an answer rather than a
// broken stream.
const listen = (server: Server, port: number, address: string): Promise<{ ok: true } | { ok: false; code: string | undefined; message: string }> =>
    new Promise((resolve) => {
        const onError = (error: NodeJS.ErrnoException): void => resolve({ ok: false, code: error.code, message: error.message });
        server.once("error", onError);
        server.listen({ port, host: address, exclusive: true }, () => {
            server.off("error", onError);
            resolve({ ok: true });
        });
    });

type Bound = { readonly ok: true; readonly close: () => Promise<void> } | { readonly ok: false; readonly reason: string };

// 127.0.0.1 always; ::1 as well for a `localhost` redirect, since a browser may resolve that name to either and one
// that picks ::1 would otherwise dead-end on a machine where nothing else answers there. ::1 is best-effort: a machine
// without IPv6 loopback still catches on 127.0.0.1.
const bind = async (spec: LoopbackCatch, onRequest: (request: IncomingMessage, response: ServerResponse) => void): Promise<Bound> => {
    const addresses = spec.host === "localhost" ? ["127.0.0.1", "::1"] : ["127.0.0.1"];
    const servers: Server[] = [];
    const sockets = new Set<Socket>();
    const close = async (): Promise<void> => {
        for (const socket of sockets) {
            socket.destroy();
        }
        await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    };
    for (const [index, address] of addresses.entries()) {
        const server = createServer(onRequest);
        server.on("connection", (socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
        const bound = await listen(server, spec.port, address);
        if (bound.ok) {
            servers.push(server);
            continue;
        }
        if (index === 0) {
            await close();
            return {
                ok: false,
                reason:
                    bound.code === "EADDRINUSE" ? `port ${spec.port} is already taken on this machine` : `could not listen on ${address}:${spec.port}: ${bound.message}`,
            };
        }
    }
    return { ok: true, close };
};

// The landing, as the address the browser asked for: rebuilt on the redirect's own host, so what the sandbox parses is
// exactly the URL the provider sent, whichever loopback address the browser happened to connect over.
const landingUrl = (spec: LoopbackCatch, request: IncomingMessage): URL => new URL(request.url ?? "/", `http://${spec.host}:${spec.port}`);

// Streams `listening`, then every landing on the path until the stream is dropped (the sandbox aborts once a landing
// completes the sign-in, or the attempt is cancelled) or the deadline passes. `busy` ends it at once.
export async function* catchLoopback(spec: LoopbackCatch, signal: AbortSignal | undefined, log: (message: string) => void): AsyncGenerator<LoopbackCatchEvent> {
    const queue: LoopbackCatchEvent[] = [];
    let wake: (() => void) | undefined;
    let over = false;
    const nudge = (): void => {
        const resume = wake;
        wake = undefined;
        resume?.();
    };
    const end = (): void => {
        over = true;
        nudge();
    };
    const bound = await bind(spec, (request, response) => {
        const url = landingUrl(spec, request);
        if (request.method !== "GET" || url.pathname !== spec.path) {
            response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
            return;
        }
        queue.push({ type: "landed", url: url.toString() });
        nudge();
        // No referrer: the address carries the grant, and nothing this page links to needs it.
        response
            .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" })
            .end(landedPage(spec.title));
    });
    if (!bound.ok) {
        log(`could not watch for the ${spec.title} sign-in: ${bound.reason}`);
        yield { type: "busy", reason: bound.reason };
        return;
    }
    log(`watching ${spec.host}:${spec.port}${spec.path} for the ${spec.title} sign-in`);
    const deadline = setTimeout(end, Math.max(0, Math.min(spec.expiresAt - Date.now(), LONGEST_WATCH_MS)));
    signal?.addEventListener("abort", end, { once: true });
    try {
        yield { type: "listening" };
        for (;;) {
            const next = queue.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (over || signal?.aborted === true) {
                break;
            }
            await new Promise<void>((resolve) => (wake = resolve));
        }
    } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", end);
        await bound.close();
        log(`stopped watching ${spec.host}:${spec.port} for the ${spec.title} sign-in`);
    }
}
