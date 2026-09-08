import { createServer, type Server, type Socket } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Logger } from "pino";
import { isLocalHost } from "../tls/local-tls.js";

// Terminates TLS itself for a local dev platform's self-signed certificate: the bundled translator (CLIProxyAPI)
// verifies it unconditionally, unlike every other caller (local-tls.ts). A loopback listener pipes bytes to the
// platform transparently. Never for a deployed platform: no listener opens, `url` stays undefined.

export interface PlatformTunnel {
    // Loopback URL for a local dev platform once bound; undefined means use the platform's own URL.
    readonly url: () => string | undefined;
    // Settles once `url()` is final; the translator awaits it so its baked config isn't racing the loopback bind.
    readonly ready: Promise<void>;
    readonly close: () => void;
}

const NO_TUNNEL: PlatformTunnel = { url: () => undefined, ready: Promise.resolve(), close: () => undefined };

// Opens the tunnel if this platform needs one. Non-throwing, non-blocking: a listener that fails to bind just leaves
// `url()` undefined, as if there were none.
export const startPlatformTunnel = (platformUrl: string, logger: Logger): PlatformTunnel => {
    let target: URL;
    try {
        target = new URL(platformUrl);
    } catch {
        return NO_TUNNEL;
    }
    if (target.protocol !== "https:" || !isLocalHost(target.hostname)) {
        return NO_TUNNEL;
    }
    const port = target.port === "" ? 443 : Number(target.port);
    let bound: number | undefined;

    const server: Server = createServer((downstream: Socket) => {
        const upstream: TLSSocket = connect({
            host: target.hostname,
            port,
            // The exception itself: a dev certificate on whatever name docker assigned; skipped for a bare IP host.
            rejectUnauthorized: false,
            ...(/^[\d.]+$|:/.test(target.hostname) ? {} : { servername: target.hostname }),
        });
        // A half-open pipe leaks a socket per turn; either side closing (or erroring) takes both down.
        const shutdown = (): void => {
            downstream.destroy();
            upstream.destroy();
        };
        downstream.on("error", shutdown);
        upstream.on("error", shutdown);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
    });

    // Settled on bind and on failure alike, so a caller awaiting the final answer always hears back.
    let settle: () => void;
    const ready = new Promise<void>((resolve) => {
        settle = resolve;
    });
    server.on("error", (error: unknown) => {
        bound = undefined;
        logger.warn({ err: error }, "platform tunnel: could not listen, the trial will use the platform URL directly");
        settle();
    });
    // Port 0: the OS picks; bound to loopback only, so nothing outside this container can reach it.
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        bound = typeof address === "object" && address !== null ? address.port : undefined;
        logger.info({ port: bound, platform: target.host }, "platform tunnel: terminating TLS for a local dev platform");
        settle();
    });
    server.unref();

    return {
        url: () => (bound === undefined ? undefined : `http://127.0.0.1:${bound}`),
        ready,
        close: () => server.close(),
    };
};
