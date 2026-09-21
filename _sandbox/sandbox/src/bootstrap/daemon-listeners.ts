import { serve, type WebSocketServerLike } from "@hono/node-server";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { WebSocketServer } from "ws";
import { createApp } from "../app.js";
import { createPreviewProxy, isPreviewHost } from "../panels/preview-proxy.js";
import { type ReachPosture, reachPosture, startIngressTunnelWhenConfigured } from "../platform/listeners/ingress-tunnel.js";
import { createLoopbackListener, type LoopbackListenerOptions } from "../platform/listeners/loopback-listener.js";
import { readLocalCertificate, startLocalCertificateRenewal } from "../platform/tls/local-cert.js";
import { publicRoot } from "../public/public-files.js";
import { createPublicHandler } from "../public/public-serve.js";
import type { BootPhase } from "./boot-phase.js";

// Every port this daemon answers on, and the one it dials out from: the API listener the browser and CLI reach, the
// preview proxy that routes subdomains to panels and forwarded ports, the loopback listener that lets a browser on this
// machine skip the tunnel, and the outbound ingress dial. Each registers its own close with the shutdown store.

type PreviewProxy = ReturnType<typeof createPreviewProxy>;

// The preview proxy as the loopback listener's second tenant: it takes the plain connections whose Host names one of
// its labels for this sandbox, so a browser on this machine frames previews without the tunnel.
const loopbackPreviewLane = (
    previewProxy: PreviewProxy | undefined,
    sandboxId: string | undefined,
): { readonly server: PreviewProxy; readonly owns: (hostHeader: string | undefined) => boolean } | undefined =>
    previewProxy === undefined ? undefined : { server: previewProxy, owns: (hostHeader) => isPreviewHost(hostHeader, sandboxId) };

// Routes preview-, port-, and public- subdomains by the Host header to a panel, a forwarded port, or the outbox;
// always listening, answering 502 rather than refusing. public/'s existence is checked per request.
const startPreviewProxy = ({ config, traits, services, shutdown }: BootPhase, host: string): PreviewProxy | undefined => {
    if (!traits.extraListeners) {
        return undefined;
    }
    const previewProxy = createPreviewProxy({
        panelOf: services.panelUpstreamOf,
        slotTargetOf: services.portForwards.targetOf,
        frameAncestors: config.webOrigin
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin !== ""),
        sandboxId: sandboxIdFromToken(config.connectToken),
        // Daemon's own address; makes this proxy the container's one front door.
        daemonPort: config.sandbox.port,
        outbox:
            config.connectToken === ""
                ? undefined
                : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
    });
    previewProxy.listen(config.preview.port, host);
    shutdown.push(() => previewProxy.close());
    return previewProxy;
};

// Same app on a second, loopback-only port, so a local browser skips the tunnel round trip. HTTP and TLS share this one
// port by sniffing the first byte; its own WebSocket server, since `ws` binds one per HTTP server. The preview proxy
// shares it too, for the plain connections whose Host names one of its labels: a browser on this machine then frames
// `port-<slot>-<id>.localhost:<this port>` instead of the tunnel.
const startLoopbackListener = (
    { config, logger, traits, role, shutdown }: BootPhase,
    host: string,
    fetch: LoopbackListenerOptions["fetch"],
    previewProxy: PreviewProxy | undefined,
): void => {
    // Meaningless when the only listener is already loopback; the local profile serves just one plain port.
    if (!traits.extraListeners) {
        return;
    }
    const localCertificate = readLocalCertificate(config);
    const localSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const localServer = createLoopbackListener({
        fetch,
        port: config.local.port,
        hostname: host,
        sockets: localSockets,
        certificate: localCertificate,
        preview: loopbackPreviewLane(previewProxy, sandboxIdFromToken(config.connectToken)),
    });
    shutdown.push(() => localServer.close());
    logger.info({ port: config.local.port, tls: localServer.tls(), hostname: localCertificate?.hostname }, "loopback listener ready");
    // Renews in the background and hands the listener whatever comes back, never rejecting. Never on a hosted machine
    // (SANDBOX_VM): there is no same-machine browser to serve, and issuing one there wastes a shared cert quota for
    // nothing.
    if (!role.container || config.sandbox.vm) {
        return;
    }
    const localCertRenewal = startLocalCertificateRenewal(config, logger, (certificate) => {
        localServer.useCertificate(certificate);
        logger.info({ hostname: certificate.hostname }, "loopback listener is serving TLS");
    });
    shutdown.push(() => localCertRenewal.stop());
};

// Returns how the world reaches this sandbox, asked once here because the outbound dial and the platform's own
// reachability probe need the same answer.
export const startDaemonListeners = (phase: BootPhase, host: string): ReachPosture => {
    const { config, logger, traits, services, shutdown } = phase;
    const app = createApp(services);
    // `/system/terminal`'s WebSocket rides node-server's native upgrade support. Cast bridges a type-only mismatch
    // between ws's `boolean | undefined` and node-server's plain-boolean option; the shapes match at runtime.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: host, websocket: { server: terminalSockets } });
    shutdown.push(() => server.close());
    logger.info(
        { host, port: config.sandbox.port, workspace: config.workspaceRoot, profile: config.sandbox.profile },
        "intentic sandbox daemon listening",
    );

    const previewProxy = startPreviewProxy(phase, host);
    startLoopbackListener(phase, host, app.fetch, previewProxy);

    /* HOW THE WORLD REACHES THIS SANDBOX: one outbound dial (platform/listeners/ingress-tunnel.ts), or nothing at all. */
    const reach = reachPosture({ url: config.ingress.url, grant: config.sandbox.grant, frontDoor: traits.extraListeners, vm: config.sandbox.vm });
    const ingressTunnel = startIngressTunnelWhenConfigured({
        url: config.ingress.url,
        grant: config.sandbox.grant,
        targetPort: config.preview.port,
        frontDoor: traits.extraListeners,
        vm: config.sandbox.vm,
        log: (message, error) => (error === undefined ? logger.info(message) : logger.warn({ err: error }, message)),
    });
    shutdown.push(() => ingressTunnel?.close());
    return reach;
};
