import { once } from "node:events";
import { rmSync } from "node:fs";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import type { Answer, FromNode, ListenConfig, Question } from "@intentic/sandbox-contract/front-wire";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { WebSocketServer } from "ws";
import { createApp } from "../app.js";
import { CONTROL_SOCKET_ENV, connectFront, HTTP_SOCKET_ENV, type FrontLink } from "../front/front-link.js";
import { answerPreview, isHandedBackPreview, PREVIEW_PROBE_PATH, type PreviewDeps, previewRoute } from "../panels/preview-routes.js";
import { type ReachPosture, reachPosture, tunnelUrl } from "../platform/listeners/reach-posture.js";
import { type LocalCertificate, readLocalCertificate, startLocalCertificateRenewal } from "../platform/tls/local-cert.js";
import { publicRoot } from "../public/public-files.js";
import { createPublicHandler } from "../public/public-serve.js";
import { buildId } from "../version.js";
import type { BootPhase } from "./boot-phase.js";

// The daemon behind intentic-front (_sandbox/front): HTTP on a Unix socket only the front dials, and every port, the
// loopback certificate and the ingress tunnel handed to the front over its control lane. Node decides; the front binds.

const previewDepsOf = ({ config, services }: BootPhase): PreviewDeps => ({
    panelOf: services.panelUpstreamOf,
    slotTargetOf: services.portForwards.targetOf,
    sandboxId: sandboxIdFromToken(config.connectToken),
    outbox:
        config.connectToken === ""
            ? undefined
            : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
});

const listenConfigOf = ({ config, traits }: BootPhase, host: string): ListenConfig => {
    const sandboxId = sandboxIdFromToken(config.connectToken);
    return {
        daemon: { host, port: config.sandbox.port },
        ...(traits.extraListeners ? { preview: { host, port: config.preview.port }, loopback: { host, port: config.local.port } } : {}),
        ...(sandboxId === undefined ? {} : { sandboxId }),
        frameAncestors: config.webOrigin
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin !== ""),
        previewProbePath: PREVIEW_PROBE_PATH,
    };
};

const certificateMessage = (certificate: LocalCertificate | undefined): FromNode => ({
    kind: "certificate",
    ...(certificate === undefined ? {} : { certificate: { certificate: certificate.certificate, privateKey: certificate.privateKey } }),
});

// Hands the front its loopback certificate now and after every renewal; the listener swaps it without a restart.
const handCertificate = (phase: BootPhase, link: FrontLink): void => {
    const { config, logger, role, traits, shutdown } = phase;
    if (!traits.extraListeners) {
        return;
    }
    link.tell(certificateMessage(readLocalCertificate(config)));
    // Never on a hosted machine: no same-machine browser exists, and issuing spends a shared cert quota.
    if (!role.container || config.sandbox.vm) {
        return;
    }
    const renewal = startLocalCertificateRenewal(config, logger, (certificate) => {
        link.tell(certificateMessage(certificate));
        logger.info({ hostname: certificate.hostname }, "the loopback listener serves TLS");
    });
    shutdown.push(() => renewal.stop());
};

const handTunnel = ({ config, logger, traits }: BootPhase, link: FrontLink): ReachPosture => {
    const reach = reachPosture({ url: config.ingress.url, grant: config.sandbox.grant, frontDoor: traits.extraListeners, vm: config.sandbox.vm });
    if (reach.by === "tunnel") {
        link.tell({ kind: "tunnel", tunnel: { url: tunnelUrl(config.ingress.url), grant: config.sandbox.grant } });
        return reach;
    }
    link.tell({ kind: "tunnel" });
    logger.info(reach.by === "direct" ? `reachable directly: ${reach.reason}` : `reachable over loopback only: ${reach.reason}`);
    return reach;
};

// Returns the reach posture once, since the platform's reachability probe needs the same answer the tunnel was given.
export const startFrontDoor = async (phase: BootPhase, host: string): Promise<ReachPosture> => {
    const { logger, services, shutdown } = phase;
    const controlPath = process.env[CONTROL_SOCKET_ENV];
    const httpPath = process.env[HTTP_SOCKET_ENV];
    if (controlPath === undefined || controlPath === "" || httpPath === undefined || httpPath === "") {
        // Before the logger's file: must be legible in `docker logs` whatever else is wrong.
        process.stderr.write(
            `FATAL: the daemon serves only behind intentic-front, which sets ${CONTROL_SOCKET_ENV} and ${HTTP_SOCKET_ENV}: ` +
                "run it as `intentic-front -- node dist/main.js`.\n",
        );
        process.exit(78); // EX_CONFIG
    }
    const preview = previewDepsOf(phase);
    let stopping = false;
    // The front repeats where the tunnel stands to every Node that says hello; only a change is news.
    let tunnelUp = false;
    const link = await connectFront({
        path: controlPath,
        answer: async (question: Question): Promise<Answer> => ({ answer: "preview", route: await previewRoute(question.host, preview) }),
        onTunnel: (connected) => {
            if (connected !== tunnelUp) {
                logger.info(connected ? "reachable: the ingress tunnel is registered" : "the ingress tunnel dropped");
            }
            tunnelUp = connected;
        },
        // The front is this process's parent: its lane closing unasked means the box is going down around it.
        onClose: () => {
            if (!stopping) {
                logger.error("intentic-front closed the control lane; stopping");
                process.kill(process.pid, "SIGTERM");
            }
        },
    });
    shutdown.push(() => {
        stopping = true;
        link.close();
    });

    const app = createApp(services);
    // The cast bridges ws's `boolean | undefined` and node-server's plain-boolean option; the shapes match at runtime.
    const sockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    // Previews the front hands back skip the app: they answer for a preview host, which the app's routes never see.
    const createServer = ((options: object, listener: RequestListener) =>
        createHttpServer(options, (request, response) => {
            if (isHandedBackPreview(request)) {
                answerPreview(request, response, preview).catch(() => response.destroy());
                return;
            }
            listener(request, response);
        })) as typeof createHttpServer;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets }, createServer });
    rmSync(httpPath, { force: true });
    server.listen(httpPath);
    await once(server, "listening");
    shutdown.push(() => server.close());

    link.tell({ kind: "listen", config: listenConfigOf(phase, host) });
    handCertificate(phase, link);
    const reach = handTunnel(phase, link);
    link.tell({ kind: "hello", build: buildId(), pid: process.pid });
    logger.info({ socket: httpPath, workspace: phase.config.workspaceRoot, profile: phase.config.sandbox.profile }, "intentic sandbox daemon serving behind the front");
    return reach;
};
