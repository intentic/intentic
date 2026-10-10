import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type RequestListener } from "node:http";
import { createAdaptorServer, type WebSocketServerLike } from "@hono/node-server";
import {
    type Answer,
    type FromNode,
    type ListenConfig,
    NETD_SOCKET_ENV,
    NODE_GENERATION_ENV,
    NODE_SOCKET_ENV,
} from "@intentic/sandbox-contract/netd-wire";
import { tunnelBulkRoutes } from "@intentic/sandbox-contract";
import { publicSlotFromToken, sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import { createApp } from "../app.js";
import { connectNetd, type NetdAsks, type NetdLink, type TunnelReport } from "../netd/netd-link.js";
import { netdCheckoutFeed, useCheckoutFeed } from "../git/feed/checkout-feed.js";
import { answerPreview, isHandedBackPreview, PREVIEW_PROBE_PATH, type PreviewDeps, previewRoute } from "../panels/preview-routes.js";
import { type ReachPosture, reachPosture, tunnelUrl } from "../system/listeners/reach-posture.js";
import { type LocalCertificate, readLocalCertificate, startLocalCertificateRenewal } from "../system/tls/local-cert.js";
import { publicRoot } from "../public/public-files.js";
import { createPublicHandler } from "../public/public-serve.js";
import type { PushSender } from "../push/push.js";
import { claimHolder, type ContainerRole } from "../system/boot/container-owner.js";
import type { ProfileTraits } from "../system/boot/profile.js";
import { sameProcess } from "../system/resources/proc-stat.js";
import { planTerminal, type TerminalPlanDeps } from "../terminal/terminal-plan.js";
import { buildId } from "../version.js";
import { LINK_LOST_EXIT } from "../system/boot/daemon-stop.js";
import { visitWorkspaceApp } from "../scaffold/app-rest.js";
import type { BootPhase } from "./boot-phase.js";

// The daemon behind intentic-netd (_sandbox/netd): HTTP on a Unix socket only netd dials, and every port, the
// loopback certificate and the ingress tunnel handed to netd over its control socket. Node decides; netd
// binds.

// The one push notification for another copy of this sandbox holding its tunnel: raised once, replaced when this copy
// holds the tunnel again.
const ELSEWHERE_TAG = "tunnel-elsewhere";

// The start of the daemon netd says this is, or none from a netd that predates generations.
export const generationOf = (env: NodeJS.ProcessEnv): number | undefined => {
    const generation = Number(env[NODE_GENERATION_ENV]);
    return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
};

export interface NetdDoorClaim {
    readonly role: ContainerRole;
    readonly traits: Pick<ProfileTraits, "convergeHome">;
    readonly controlPath: string;
    // The control socket the live daemon owning this container dials: undefined when none lives, null when one does and
    // its socket cannot be read.
    readonly ownerControlPath: () => string | null | undefined;
}

// Why this daemon must not take netd's sockets, or undefined when they are its own. They belong to the daemon that
// owns the container: a guest (a second daemon, a run from an agent's session) that went on would remove the owner's
// HTTP socket and listen in its place, and dial the control socket the owner holds (2026-10-05). A local daemon's role
// is pinned and its netd its own. A guest still serves under a netd of its own, one whose control socket the owner
// does not dial, and where no live daemon owns the container (one that could not claim it) there is nobody to protect.
export const netdDoorRefusal = ({ role, traits, controlPath, ownerControlPath }: NetdDoorClaim): string | undefined => {
    if (role.container || !traits.convergeHome) {
        return undefined;
    }
    const owners = ownerControlPath();
    if (owners === undefined || (owners !== null && owners !== controlPath)) {
        return undefined;
    }
    return `this daemon is a guest in a container another live daemon owns, and ${controlPath} is that daemon's netd: it does not take netd's sockets`;
};

// The control socket the live daemon holding this container's claim was started with, read from its environment.
const ownerControlPath = (): string | null | undefined => {
    const owner = claimHolder();
    if (owner === undefined || owner.pid === process.pid || !sameProcess(owner)) {
        return undefined;
    }
    try {
        const prefix = `${NETD_SOCKET_ENV}=`;
        const entry = readFileSync(`/proc/${owner.pid}/environ`, "utf8")
            .split("\0")
            .find((variable) => variable.startsWith(prefix));
        return entry === undefined ? null : entry.slice(prefix.length);
    } catch {
        // allow(silent-catch): an owner whose environment cannot be read (gone meanwhile, or another user's) reads as one that
        // named no socket, which keeps this daemon off the owner's netd rather than guessing it free
        return null;
    }
};

// A machine as a notification names it.
const machineNamed = (host: string): string => (host === "" ? "Another machine" : host);

const elsewhereNotice = (host: string) => ({
    title: "Another copy of this sandbox is running",
    body: `${machineNamed(host)} runs this sandbox too, and holds its address. Stop one of the two to keep working in this one.`,
    tag: ELSEWHERE_TAG,
    requireInteraction: true,
});

const heldAgainNotice = () => ({
    title: "This sandbox is reachable again",
    body: "The other copy stopped, and this one holds its address again.",
    tag: ELSEWHERE_TAG,
    silent: true,
});

// What the daemon makes of netd's tunnel reports: a line in daemon.log on each change, with netd's reason
// (before 2026-10-05 a drop was logged with none, and netd's reason reached its stdout only), and one owner-facing
// notification while another copy of this sandbox keeps its tunnel, replaced once this copy holds it again. The owner's
// editor reaches whichever copy holds the address, so a push to their devices is what reaches them from this one.
export const tunnelReports = (
    logger: Pick<Logger, "info" | "warn" | "error">,
    push: Pick<PushSender, "notifyIfAway" | "withdraw">,
): ((connected: boolean, report: TunnelReport) => void) => {
    let up = false;
    let reason: string | undefined;
    let elsewhere: string | undefined;
    let deleted = false;
    return (connected, report) => {
        if (connected) {
            if (!up) {
                logger.info("reachable: the ingress tunnel is registered");
            }
            if (elsewhere !== undefined) {
                logger.info({ host: elsewhere }, "this copy of the sandbox holds its tunnel again");
                void push.withdraw(heldAgainNotice());
            }
            up = true;
            reason = undefined;
            elsewhere = undefined;
            deleted = false;
            return;
        }
        if (up || report.reason !== reason) {
            logger.warn({ reason: report.reason ?? "netd gave no reason" }, "the ingress tunnel dropped");
        }
        up = false;
        reason = report.reason;
        const refused = report.refused;
        if (refused?.refusal === "elsewhere" && refused.host !== elsewhere) {
            elsewhere = refused.host;
            logger.warn(
                { host: refused.host },
                `another copy of this sandbox is running on ${machineNamed(refused.host)} and holds its address; this one dials the ingress every 15 minutes until it stops`,
            );
            void push.notifyIfAway(elsewhereNotice(refused.host));
        }
        if (refused?.refusal === "deleted" && !deleted) {
            deleted = true;
            logger.error("the platform deleted this sandbox: netd stopped dialling the ingress");
        }
    };
};

const previewDepsOf = ({ config, services }: BootPhase): PreviewDeps => ({
    panelOf: services.panelUpstreamOf,
    visit: visitWorkspaceApp,
    slotTargetOf: services.portForwards.targetOf,
    sandboxId: sandboxIdFromToken(config.connectToken),
    outbox:
        config.connectToken === ""
            ? undefined
            : { slot: publicSlotFromToken(config.connectToken), serve: createPublicHandler(publicRoot(config.workspaceRoot)) },
});

const terminalDepsOf = ({ logger, services }: BootPhase): TerminalPlanDeps => ({
    auth: services.auth,
    wsTickets: services.wsTickets,
    root: services.workspace.root,
    logPathOf: services.serviceProcesses.logPathOf,
    warn: (fields, message) => logger.warn(fields, message),
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

// Hands netd its loopback certificate now and after every renewal; the listener swaps it without a restart.
const handCertificate = (phase: BootPhase, link: NetdLink): void => {
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

const handTunnel = ({ config, logger, traits }: BootPhase, link: NetdLink): ReachPosture => {
    const reach = reachPosture({ url: config.ingress.url, grant: config.sandbox.grant, frontDoor: traits.extraListeners });
    if (reach.by === "tunnel") {
        link.tell({ kind: "tunnel", tunnel: { url: tunnelUrl(config.ingress.url), grant: config.sandbox.grant, bulk: tunnelBulkRoutes() } });
        return reach;
    }
    link.tell({ kind: "tunnel" });
    logger.info(`reachable over loopback only: ${reach.reason}`);
    return reach;
};

// Returns the reach posture once, since the platform's reachability probe needs the same answer the tunnel was given.
// Node's HTTP server on netd's socket. Previews netd hands back skip the app: they answer for a preview host,
// which the app's routes never see.
export const netdDoorServer = (preview: PreviewDeps, logger: Pick<Logger, "warn">): typeof createHttpServer =>
    ((options: object, listener: RequestListener) => {
        const server = createHttpServer(options, (request, response) => {
            if (isHandedBackPreview(request)) {
                answerPreview(request, response, preview).catch((error: unknown) => {
                    logger.warn({ err: error, host: request.headers.host }, "netd door: a handed-back preview could not be answered");
                    response.destroy();
                });
                return;
            }
            listener(request, response);
        });
        // netd is the only client and drops idle sockets itself; this timer, due after a stall, would close one
        // whose next request already sits unread in it.
        server.keepAliveTimeout = 0;
        // An upload reaches this socket at the uploader's pace, which netd and the edge police, not a 5-minute cap.
        server.requestTimeout = 0;
        return server;
    }) as typeof createHttpServer;

// The two sockets intentic-netd names for the daemon it spawns: its control link, and where this daemon serves HTTP.
export interface NetdSockets {
    readonly controlPath: string;
    readonly httpPath: string;
}

// The daemon serves only behind intentic-netd. Checked with the other refusals in main.ts, before anything is converged,
// built or bound, so a start outside netd changes nothing on its way out; read once, since the environment forgets both
// names once the door has dialled them (daemon-env.ts).
export const requireNetdSockets = (env: NodeJS.ProcessEnv = process.env): NetdSockets => {
    const controlPath = env[NETD_SOCKET_ENV];
    const httpPath = env[NODE_SOCKET_ENV];
    if (controlPath === undefined || controlPath === "" || httpPath === undefined || httpPath === "") {
        // Before the logger: must be legible in `docker logs` whatever else is wrong.
        process.stderr.write(
            `FATAL: the daemon serves only behind intentic-netd, which sets ${NETD_SOCKET_ENV} and ${NODE_SOCKET_ENV}: ` +
                "run it as `intentic-netd -- node dist/main.js`.\n",
        );
        process.exit(78); // EX_CONFIG
    }
    return { controlPath, httpPath };
};

export const startNetdDoor = async (phase: BootPhase, host: string, { controlPath, httpPath }: NetdSockets): Promise<ReachPosture> => {
    const { logger, services, shutdown } = phase;
    const refusal = netdDoorRefusal({ role: phase.role, traits: phase.traits, controlPath, ownerControlPath });
    if (refusal !== undefined) {
        // A boot failure: logged, and a guest's records nothing for the host (boot-failure.ts).
        throw new Error(refusal);
    }
    const preview = previewDepsOf(phase);
    const terminal = terminalDepsOf(phase);
    let stopping = false;
    const link = await connectNetd({
        path: controlPath,
        answer: async (question: NetdAsks): Promise<Answer> => {
            switch (question.question) {
                case "preview":
                    return { answer: "preview", route: await previewRoute(question.host, question.probe, preview) };
                case "terminal":
                    return planTerminal(terminal, question.query);
            }
        },
        // netd repeats where the tunnel stands to every Node that says hello; only a change is news.
        onTunnel: tunnelReports(logger, services.pushSender),
        onFault: (error) => logger.warn({ err: error }, "netd link: fault on the control socket"),
        // The link closing unasked: netd dropped it (a frame it could not read) or is going away. Either way this daemon
        // cannot serve without it, and exits for a fresh start; netd going down takes no notice of the code.
        onClose: () => {
            if (!stopping) {
                logger.error("intentic-netd closed the control socket; exiting so netd starts this daemon again");
                phase.stop(LINK_LOST_EXIT);
            }
        },
    });
    shutdown.push(() => {
        stopping = true;
        link.close();
    });
    // Status reads keyed on netd's change counts from here on (git/feed/checkout-feed.ts).
    useCheckoutFeed(netdCheckoutFeed(link));
    shutdown.push(() => useCheckoutFeed(undefined));
    // netd's terminals never register here: every revocation is relayed, and netd matches it by member.
    const unrelay = services.auth?.connections.onRevoke((member) => link.tell({ kind: "revoke", ...(member === undefined ? {} : { member }) }));
    shutdown.push(() => unrelay?.());

    const app = createApp(services);
    // The cast bridges ws's `boolean | undefined` and node-server's plain-boolean option; the shapes match at runtime.
    const sockets = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    const server = createAdaptorServer({ fetch: app.fetch, websocket: { server: sockets }, createServer: netdDoorServer(preview, logger) });
    rmSync(httpPath, { force: true });
    server.listen(httpPath);
    await once(server, "listening");
    shutdown.push(() => server.close());

    link.tell({ kind: "listen", config: listenConfigOf(phase, host) });
    handCertificate(phase, link);
    const reach = handTunnel(phase, link);
    const generation = generationOf(process.env);
    link.tell({ kind: "hello", build: buildId(), pid: process.pid, ...(generation === undefined ? {} : { generation }) });
    logger.info(
        { socket: httpPath, workspace: phase.config.workspaceRoot, profile: phase.config.sandbox.profile },
        "intentic sandbox daemon serving behind netd",
    );
    return reach;
};
