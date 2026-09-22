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

// Every port this daemon answers on and the one dial it makes out; each registers its own close with the shutdown store.

type PreviewProxy = ReturnType<typeof createPreviewProxy>;

// The preview proxy as the loopback listener's second tenant: plain connections whose Host names one of its labels.
const loopbackPreviewLane = (
    previewProxy: PreviewProxy | undefined,
    sandboxId: string | undefined,
): { readonly server: PreviewProxy; readonly owns: (hostHeader: string | undefined) => boolean } | undefined =>
    previewProxy === undefined ? undefined : { server: previewProxy, owns: (hostHeader) => isPreviewHost(hostHeader, sandboxId) };

// Always listening, answering 502 rather than refusing; public/'s existence is checked per request.
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

// HTTP and TLS share the one port by sniffing the first byte; `ws` binds one WebSocket server per HTTP server.
const startLoopbackListener = (
    { config, logger, traits, role, shutdown }: BootPhase,
    host: string,
    fetch: LoopbackListenerOptions["fetch"],
    previewProxy: PreviewProxy | undefined,
): void => {
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
    // Never on a hosted machine: no same-machine browser exists, and issuing spends a shared cert quota.
    if (!role.container || config.sandbox.vm) {
        return;
    }
    const localCertRenewal = startLocalCertificateRenewal(config, logger, (certificate) => {
        localServer.useCertificate(certificate);
        logger.info({ hostname: certificate.hostname }, "loopback listener is serving TLS");
    });
    shutdown.push(() => localCertRenewal.stop());
};

// Returns the reach posture once, since the outbound dial and the platform's reachability probe need the same answer.
export const startDaemonListeners = (phase: BootPhase, host: string): ReachPosture => {
    const { config, logger, traits, services, shutdown } = phase;
    const app = createApp(services);
    // The cast bridges ws's `boolean | undefined` and node-server's plain-boolean option; the shapes match at runtime.
    const terminalSockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = serve({ fetch: app.fetch, port: config.sandbox.port, hostname: host, websocket: { server: terminalSockets } });
    shutdown.push(() => server.close());
    logger.info(
        { host, port: config.sandbox.port, workspace: config.workspaceRoot, profile: config.sandbox.profile },
        "intentic sandbox daemon listening",
    );

    const previewProxy = startPreviewProxy(phase, host);
    startLoopbackListener(phase, host, app.fetch, previewProxy);

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
