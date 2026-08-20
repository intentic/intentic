import { createServer, type Server, type Socket } from "node:net";
import { connect, type TLSSocket } from "node:tls";
import type { Logger } from "pino";
import { isLocalHost } from "./local-tls.js";

/* THE EXCEPTION FOR A DEV PLATFORM, MADE ON BEHALF OF SOMETHING THAT CANNOT MAKE IT ITSELF.
 *
 * A platform being developed on the owner's own machine serves a self-signed certificate, and local-tls.ts
 * states the rule every sandbox→platform caller follows: on localhost / 127.0.0.1 / host.docker.internal, do
 * not verify it. Every caller in this daemon does. One caller is not in this daemon.
 *
 * CLIProxyAPI is a Go binary we bundle and configure, and the free trial reaches Google THROUGH it: the trial
 * is an `openai` endpoint whose base URL is the platform's, so the translator, not the daemon, is what opens
 * that connection when a turn is sent. It verifies, correctly and unconditionally, and against a dev platform
 * it therefore fails every time:
 *
 *     tls: failed to verify certificate: x509: certificate is valid for localhost, not host.docker.internal
 *
 * It answers that as a 500, the harness reads a 500 as the provider being down and rides its retry budget, and
 * the chat shows "The model provider is not responding, retrying in 10s (attempt 5)" until the turn gives up.
 * Nothing in that sentence is true and nothing in it points here, which is what made it expensive: the trial
 * looked broken, Google looked broken, and the actual fault was a certificate name.
 *
 * Neither end can be fixed where it is. The certificate cannot name `host.docker.internal`, the development CA
 * is name-constrained to localhost on purpose (_tools/localhost-https), and the translator has no per-upstream
 * "skip verification" to set. So the daemon terminates the TLS itself: a loopback TCP listener inside this
 * container that pipes bytes to the platform over a connection whose certificate it declines to verify, exactly
 * as localTolerantFetch declines to. Byte-for-byte transparent, so a streamed completion streams.
 *
 * ONLY EVER FOR A LOCAL PLATFORM. A deployed one presents a real certificate on a real name and gets none of
 * this: no listener is opened, `url` is undefined, and every caller keeps the platform's own URL. There is no
 * configuration to get wrong and no way to point this at something on the internet, the same closed list
 * local-tls.ts owns decides it.
 */

export interface PlatformTunnel {
    /* The loopback `http://127.0.0.1:<port>` that stands in for a LOCAL dev platform, once the listener is up.
     * `undefined` on a deployed platform (there is nothing to work around) and before the listener binds, and
     * both mean the same thing to a caller: use the platform's own URL. */
    readonly url: () => string | undefined;
    /* Settles once `url()` has its final answer: the listener bound, failed to bind, or was never needed.
     * For the one caller that WRITES `url()` down rather than reading it fresh per call — the translator's
     * config render bakes the trial's base URL into a file at boot — awaiting this is what makes the baked
     * address deterministic instead of a race against a loopback bind that is merely almost always faster. */
    readonly ready: Promise<void>;
    readonly close: () => void;
}

const NO_TUNNEL: PlatformTunnel = { url: () => undefined, ready: Promise.resolve(), close: () => undefined };

/* Open the tunnel if this platform needs one. Non-throwing and non-blocking, like every other boot-time
 * best-effort here: a listener that cannot bind leaves `url()` undefined, which is precisely the behaviour of
 * a daemon that never had one. */
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
            // The whole point, and the same exception local-tls.ts grants, a dev certificate on a name docker
            // gave us. SNI is still sent where there is a name to send, so a platform serving several picks the
            // right one; RFC 6066 forbids an IP literal there and node warns about it, so 127.0.0.1 sends none.
            rejectUnauthorized: false,
            ...(/^[\d.]+$|:/.test(target.hostname) ? {} : { servername: target.hostname }),
        });
        // A half-open pipe leaks a socket per turn. Either end closing takes both down, and an error is a close
        // with a reason, logged nowhere, because the caller above will report its own failure in its own words.
        const shutdown = (): void => {
            downstream.destroy();
            upstream.destroy();
        };
        downstream.on("error", shutdown);
        upstream.on("error", shutdown);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
    });

    // Settled on bind AND on failure: a caller waiting for the final answer must hear "there is none" too, or
    // a port that cannot bind would hold the translator's config render for the daemon's lifetime.
    let settle: () => void;
    const ready = new Promise<void>((resolve) => {
        settle = resolve;
    });
    server.on("error", (error: unknown) => {
        bound = undefined;
        logger.warn({ err: error }, "platform tunnel: could not listen — the trial will use the platform URL directly");
        settle();
    });
    // Port 0: the OS picks. Nothing outside this container may reach it, so it is bound to loopback only and
    // there is no port to reserve, publish or collide on.
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
