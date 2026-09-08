import {
    REQUEST_ID_HEADER,
    roleAtLeast,
    runnerTranslatorPath,
} from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerFrom, ForbiddenError } from "./auth/auth.js";
import { createAccessRoutes } from "./auth/access.routes.js";
import { createControlTokenRoutes } from "./auth/control-tokens.routes.js";
import { createMembersRoutes } from "./auth/members.routes.js";
import { routeFloor } from "./auth/role-floor.js";
import { admitByGrant, grantsOf } from "./auth/grants.js";
import { createAutomationFireRoute } from "./automations/fire.routes.js";
import { createCapabilityAskRoutes } from "./capabilities/ask.routes.js";
import type { Services } from "./composition.js";
import { type AppEnv, buildOrpcContext } from "./app-env.js";
import { createDiffRawRoute } from "./git/changes/diff-raw.js";
import { createSpeechRoute } from "./speech/speech.routes.js";
import { createEnrollRoute } from "./inventory/enroll.routes.js";
import { createRouter } from "./router.js";
import { verifySyncToken } from "./platform/sync.js";
import { createSyncRoutes } from "./platform/sync.routes.js";
import { createSyncSshRoute } from "./platform/sync-ssh.js";
import { createWalletRoutes } from "./wallet/wallet.routes.js";
import { createFleetRoutes } from "./agents/recall/fleet.routes.js";
import { createChildrenRoutes } from "./agent/subagents/children.routes.js";
import { createEnvironmentRoutes } from "./environment/environment.routes.js";
import { createEnginesRoutes } from "./engines/engines.routes.js";
import { createBundleRoutes } from "./portability/bundle.routes.js";
import { createDefinitionRoutes } from "./portability/definition.routes.js";
import { createArrivalRoutes } from "./portability/arrival.routes.js";
import { createCiWebhookRoute } from "./ci/webhook.routes.js";
import { createBackendProxyRoute } from "./extensions/backend/backend-proxy.routes.js";
import { createExtensionBundleRoute } from "./extensions/extension-bundle.routes.js";
import { createListenerRoutes } from "./extensions/listener.routes.js";
import { createBrowserProfileRoute } from "./browser/sessions/browser-profile.js";
import { createDevicesRoute } from "./hosts/devices.routes.js";
import { HOST_PEER, hostPeerRoutes } from "./hosts/host-peer.js";
import { peerConnectPath, peerEnrollPath, peerMcpPath } from "./peers/peer.js";
import { mountPeerRoutes } from "./peers/peer-routes.js";
import { RUNNER_PEER, runnerPeerRoutes } from "./runners/runner-peer.js";
import { WEBEXT_PEER, webextPeerRoutes } from "./webext/webext-peer.js";
import { createWebExtLendRoute, createWebExtSessionRoute } from "./webext/webext.routes.js";
import { createRunnerDefinitionSyncRoute } from "./runners/runner.routes.js";
import {
    createRunnerCredentialRefreshRoute,
    createRunnerCredentialsRoute,
    createRunnerTranslatorProxyRoute,
} from "./runners/runner-credentials.routes.js";
import { createRunnerGitRefsRoute, createRunnerGitRpcRoute } from "./runners/runner-git.routes.js";
import { createBrowserViewRoute } from "./browser/cast/browser-view.js";
import { createTerminalRoute } from "./terminal/terminal.js";
import { createWebchatRoutes } from "./webchat/webchat.routes.js";
import { createWidgetRoute } from "./webchat/webchat-widget.js";
import { createIntakeRoutes } from "./issues/intake.routes.js";
import { createSdkRoute } from "./issues/issue-sdk.js";
import { createGateRoute } from "./workflows/gate.routes.js";
import { createWorkspaceBytesRoutes } from "./workspace/files/workspace-bytes.routes.js";
import { reachPosture } from "./platform/listeners/ingress-tunnel.js";
import { profileTraits } from "./platform/boot/profile.js";

// Only genuine server faults (5xx) are logged; expected ORPCErrors are the routes' normal control flow.
const logUnexpectedError = (services: Services, error: unknown): void => {
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return;
    }
    services.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "unhandled error");
};

// Webhook fire for event automations; external callers, so exempt from bearer auth, gated by its own token.
const eventFirePath = /^\/automations\/[^/]+\/fire$/;

// The Front Desk's public surface for anonymous visitors; exempt from bearer auth, gated by the automation's origin
// allowlist, rate limit and bot check instead.
// One predicate for the whole set, not a constant per route, so the boundary can't be widened by touching just one
// name.
const webchatPublicPath = (path: string): boolean => path === "/webchat/widget.js" || /^\/webchat\/[^/]+\/(message|config|challenge)$/.test(path);

// The bug intake's public surface, the daemon's other anonymous door; gated by the automation's origin allowlist or
// ingest key, rate window and daily ceiling.
// Kept separate from `/issues` (the owner's inbox, behind bearer auth): the two are keyed differently, an automation id
// here, an issue fingerprint there.
const intakePublicPath = (path: string): boolean => path === "/intake/sdk.js" || /^\/intake\/[^/]+\/(report|config|challenge)$/.test(path);

// The path the router will actually match: oRPC normalizes a trailing slash before dispatch, so a `$`-anchored rule
// must check the same normalized path.
// Normalized once here rather than per predicate; a root path stays `/`, repeated slashes collapse.
const routedPath = (path: string): string => path.replace(/\/+$/u, "") || "/";

// CI webhook receiver; no Google token, so gated by the per-sandbox webhook secret instead of bearer auth.
const ciWebhookPath = /^\/ci\/webhook\/[^/]+$/;

// Release gate; pipeline runners carry no Google token or Origin, gated by the workflow's own gate token.
const gatePath = /^\/workflows\/[^/]+\/gate$/;

// The peer doors: a device, browser or runner dials in with its enrollment token at `connect`/`enroll`; MCP bridges
// carry the per-boot bridge token.
// Anchored per segment so none admits a route that merely starts the same way.
const PEER_DOORS = [HOST_PEER, WEBEXT_PEER, RUNNER_PEER];
const peerPublicPath = (path: string): boolean => PEER_DOORS.some((door) => path === peerConnectPath(door.slug) || path === peerEnrollPath(door.slug));
const peerMcpPaths = PEER_DOORS.flatMap((door) => (door.mcp === undefined ? [] : [peerMcpPath(door.slug)]));

// A connected browser's two credential doors: `session`/`lend` carry a durable token, self-verified.
// `session` moves a site sign-in into a sandbox profile; `lend` moves one back out.
const webextCredentialPath = (path: string): boolean => path === "/system/webext/session" || path === "/system/webext/lend";

// A runner's other doors: its own bearer token for the git routes, plus its credential doors (runners/).
const runnerGitPath = /^\/system\/runners\/git\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
const runnerPublicPath = (path: string): boolean =>
    path === "/system/runners/credentials" ||
    path === "/system/runners/credentials/refresh" ||
    path.startsWith("/system/runners/translator/") ||
    runnerGitPath.test(path);

// Routes that answer before the boot chain converges: /health and /events show boot progress, WebSocket upgrades live
// outside boot state.
// /system/session and /system/presence are boot-independent too (session secret on /history, roster in memory);
// everything else waits.
// Long-lived streams exempt from the request timer: meant to stay open, so timing would bury real slow work.
const STREAM_PATHS = new Set(["/events", "/agent/attach", "/intentic/apply/events"]);

const READY_EXEMPT = new Set([
    "/health",
    "/events",
    "/system/session",
    "/system/presence",
    "/system/ws-ticket",
    "/system/terminal",
    "/system/browser-profile",
    "/system/browser-view",
    // Peer door sockets reconnect on their own backoff; a browser's MV3 worker dies after ~30s of silence.
    ...PEER_DOORS.map((door) => peerConnectPath(door.slug)),
]);

// The HTTP API the browser drives directly; when services.auth is set every route but /health verifies the owner's
// Google ID token.
// services.boot gates data routes behind the boot chain instead of racing it, while listeners come up as soon as the
// process can serve.
export const createApp = (services: Services): Hono<AppEnv> => {
    const orpcHandler = new OpenAPIHandler(createRouter(services), {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    // A client that vanished mid-request leaves the stream aborted; oRPC's input decode then throws,
                    // downgraded to a 400 nobody reads.
                    // Not an incident: the bearer middleware awaits authorize() before the body is read, so a cancelled
                    // in-flight POST lands here routinely.
                    if (options.request.signal?.aborted !== true) {
                        logUnexpectedError(services, error);
                    }
                    throw error;
                }
            },
        ],
    });

    const app = new Hono<AppEnv>();

    // Response hardening, above everything so it covers error paths too; only `nosniff` (/workspace/raw serves
    // arbitrary bytes) and Referrer-Policy (the hostname carries the sandbox id) actually matter here.
    // Cross-Origin-Resource-Policy is off: /webchat/widget.js is loaded as a plain <script> from third-party sites,
    // which CORP would block.
    app.use("*", secureHeaders({ crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));

    // Outermost: times the answer the browser actually waited for, the only number that also covers the boot gate, auth
    // and oRPC validation.
    // Streams are exempt since they're long-lived by design; timing them would log every healthy connection as the
    // slowest request.
    app.use("*", async (c, next) => {
        if (STREAM_PATHS.has(c.req.path)) {
            return next();
        }
        const from = process.hrtime.bigint();
        await next();
        // The browser's own id for this call, echoed onto the served line so a report matches a log line by id.
        const requestId = c.req.header(REQUEST_ID_HEADER);
        services.perf.record("http.request", Number(process.hrtime.bigint() - from) / 1e6, {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            ...(requestId !== undefined ? { requestId } : {}),
        });
    });

    // The boot gate, first so nothing below runs against half-built state; waiting here is strictly less than the
    // connection-refused window it replaces.
    // Read per request, never captured: a boot tracker main() declares after the app is built still gates requests that
    // arrive next.
    app.use("*", async (c, next) => {
        if (!READY_EXEMPT.has(c.req.path)) {
            await services.boot.converged;
        }
        return next();
    });

    // CORS is emitted in every auth mode, from the same allowlist the authorizer would use.
    // The local profile needs it too: its host serves the app from its own origin, so the browser preflights loopback
    // like any cross-origin call.
    const allowOrigins = services.config.webOrigin
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== "");
    // An allowlist entry may name a family: `https://*.example.net` admits any single label in the wildcard position,
    // for an editor webview's per-session origin.
    // Still an allowlist, not a wildcard: the scheme and suffix are pinned, only one label floats.
    const originAllowed = (origin: string): boolean =>
        allowOrigins.some((entry) => {
            const star = entry.indexOf("*");
            if (star === -1) {
                return entry === origin;
            }
            const prefix = entry.slice(0, star);
            const suffix = entry.slice(star + 1);
            const label = origin.slice(prefix.length, origin.length - suffix.length);
            return origin.startsWith(prefix) && origin.endsWith(suffix) && label.length > 0 && !label.includes(".") && !label.includes("/");
        });
    app.use(
        "*",
        cors({
            // The daemon is owner-driven from one origin, except the webchat widget, embedded on third-party sites:
            // reflect the caller's origin there, the route's own allowlist is the real gate.
            // Everywhere else this is an allowlist, never a wildcard, since /health answers a stranger with the sandbox
            // id the loopback port derives from.
            origin: (origin, c) => {
                if (webchatPublicPath(c.req.path) || intakePublicPath(c.req.path)) {
                    return origin ?? "*";
                }
                // Reflect only a match; the first entry for a foreign origin would hide a misconfig. null means no
                // header.
                return originAllowed(origin) ? origin : null;
            },
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            // REQUEST_ID_HEADER must be allow-listed too, or the preflight drops it and the correlation stays empty.
            allowHeaders: ["authorization", "content-type", "x-intentic-connect", "x-intentic-base-hash", REQUEST_ID_HEADER],
            maxAge: 600,
        }),
    );

    if (services.auth !== undefined) {
        const authorize = services.auth.authorize;
        // Built once: secrets are per-boot and the stores are already live, so nothing here is per-request.
        const grants = grantsOf({
            panelToken: services.panelToken,
            agentToken: services.agentToken,
            controlTokens: services.controlTokens,
            verifySync: (presented, checkedIn) => verifySyncToken(services.config.historyRoot, presented, checkedIn),
            verifyExtension: (presented) => services.extensionBackend.verifyExtensionToken(presented),
        });
        app.use("*", async (c, next) => {
            // /system/terminal is a WebSocket upgrade with no Authorization header; it authorizes via the query string.
            // /system/authorized-key is the desktop-sync agent's door: POST redeems a one-time pairing, DELETE is the
            // agent revoking with its own sync token.
            // Exact-path only: the owner's per-machine revoke (/system/authorized-key/:machine) is not exempt and goes
            // through this middleware.
            if (
                c.req.path === "/health" ||
                c.req.path === "/system/terminal" ||
                // /system/browser-profile authorizes token+connect from the query string too, like the terminal.
                c.req.path === "/system/browser-profile" ||
                // /system/browser-view is the same screencast wire, pointed at the browser the agent drives.
                c.req.path === "/system/browser-view" ||
                // /workspace/media is fetched by a <video>/<audio> tag with no header; it checks its own scoped ticket
                // instead.
                c.req.path === "/workspace/media" ||
                // /bundles/download is navigated to, so no header either; it checks its own ticket, scoped to the named
                // bundle.
                c.req.path === "/bundles/download" ||
                c.req.path === "/enroll" ||
                c.req.path === "/system/authorized-key" ||
                // Account deletion must stay repeatable after a partial attempt; the handler does its own owner check.
                c.req.path === "/system/access/disable" ||
                eventFirePath.test(c.req.path) ||
                webchatPublicPath(c.req.path) ||
                intakePublicPath(c.req.path) ||
                ciWebhookPath.test(c.req.path) ||
                gatePath.test(c.req.path) ||
                peerPublicPath(c.req.path) ||
                peerMcpPaths.some((pattern) => pattern.test(c.req.path)) ||
                webextCredentialPath(c.req.path) ||
                runnerPublicPath(c.req.path)
            ) {
                return next();
            }
            // The non-bearer credentials (a panel, the vpn CLI, a control token, the desktop-sync agent) are admitted
            // only here, per the table in auth/grants.ts.
            // Identity stays unset for all of them, acting as the owner's tool; a control token that can name its
            // holder hands back a principal instead (auth/principal.ts).
            const admission = await admitByGrant(grants, (name) => c.req.header(name), c.req.method, routedPath(c.req.path));
            if (admission !== undefined) {
                if (!admission.admitted) {
                    return c.json({ error: admission.error }, admission.status);
                }
                if (admission.principal !== undefined) {
                    c.set("principal", admission.principal);
                }
                return next();
            }
            try {
                const caller = await authorize(bearerFrom(c.req.header("authorization")), c.req.header("x-intentic-connect") ?? undefined);
                c.set("identity", caller);
                // The role floor (auth/role-floor.ts) applies here, after authentication, in one place: a member below
                // a route's tier gets a 403 naming the tier.
                // Owner-only routes still keep their own in-route gates besides; this floor only keeps a viewer
                // read-only and a collaborator off ship controls.
                const floor = routeFloor(c.req.method, c.req.path, c.req.query("path"));
                if (!roleAtLeast(caller.role, floor)) {
                    return c.json({ error: `${floor} access required`, floor }, 403);
                }
            } catch (error) {
                // 403 is a verified identity that isn't the owner/member; 401 reads like any other unreachable daemon.
                if (error instanceof ForbiddenError) {
                    return c.json({ error: error.message }, 403);
                }
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    // Unauthenticated by design: the "is a daemon there" probe every flow uses (launch scripts, /setup, the browser's
    // loopback probe).
    // The sandbox id lets a loopback probe confirm it reached this daemon, not an unrelated process; `boot` tells "not
    // answering" from "still converging".
    // `announce` is the one signal for whether this daemon reached the platform; ic reads it via docker exec.
    app.get("/health", (c) =>
        c.json({
            ok: true,
            sandboxId: sandboxIdFromToken(services.config.connectToken),
            // Which posture answers (platform/profile.ts); needed before any authenticated read.
            profile: services.config.sandbox.profile,
            boot: services.boot.progress(),
            announce: services.announcer.status(),
            // Whether this sandbox's public address answers, probed by the box itself.
            reach: services.reach.status(),
            // How the world reaches here: a dialed tunnel, direct (a Fly machine, no process on path), or loopback.
            reachedBy: reachPosture({
                url: services.config.ingress.url,
                grant: services.config.sandbox.grant,
                frontDoor: profileTraits(services.config).extraListeners,
                vm: services.config.sandbox.vm,
            }).by,
        }),
    );

    // Same bytes as one side of a diff instead of a tree file; off oRPC since the body is streamed binary.
    app.route("/", createDiffRawRoute(services));

    // Composer voice input, a WAV in, text out; off oRPC since the contract carries no audio.
    app.route("/", createSpeechRoute(services));

    // The workspace's byte routes: raw file read, the ranged media read a <video> talks to, and the three upload doors.
    // Off oRPC since their bodies are streamed bytes; registered before the catch-all, like /health.
    const workspaceBytes = createWorkspaceBytesRoutes(services);
    app.get("/workspace/raw", workspaceBytes.raw);
    app.get("/workspace/media", workspaceBytes.media);
    app.post("/workspace/upload", workspaceBytes.upload);
    app.post("/workspace/upload-diff", workspaceBytes.uploadDiff);
    app.post("/workspace/upload-archive", workspaceBytes.uploadArchive);

    // Browser credentials: the one-shot ticket the WebSocket upgrades redeem, minted over HTTP so auth can bind it.
    const access = createAccessRoutes(services);
    app.post("/system/ws-ticket", access.wsTicket);

    // Interactive PTY over a WebSocket, paired with the `ws` server in main.ts; matched before the oRPC catch-all.
    app.get("/system/terminal", createTerminalRoute(services));

    // Desktop sync's transport: this container's sshd as a byte stream, authorized via the ordinary grant table.
    app.get("/system/sync/ssh", createSyncSshRoute(services));

    // A browser-kind capability's own Chromium: a WebSocket on the platform profile, same auth as the terminal.
    app.get("/system/browser-profile", createBrowserProfileRoute(services));

    // Watch the browser the agent drives: the same screencast wire, attached to a live browser-* session.
    app.get("/system/browser-view", createBrowserViewRoute(services));

    // Deploy-target enrollment (connect token) and the automation fire (own token); both exempt from bearer auth.
    app.post("/enroll", createEnrollRoute(services));
    app.post("/automations/:id/fire", createAutomationFireRoute(services));

    // The release gate: a pipeline runner POSTs here and waits for the verdict, authenticated by the workflow's own
    // minted gate token.
    // The only route in the daemon that holds a request open for the work it started.
    app.post("/workflows/:id/gate", createGateRoute(services));

    // The Front Desk: widget bundle, per-automation config, bot challenge, and the message ingest streaming its reply
    // as SSE.
    // All exempt from bearer auth, gated by origin allowlist, rate limit and bot check instead; `widget.js` is declared
    // first so the :id routes can't shadow it.
    const webchat = createWebchatRoutes(services);
    app.get("/webchat/widget.js", createWidgetRoute());
    app.get("/webchat/:id/config", webchat.config);
    app.get("/webchat/:id/challenge", webchat.challenge);
    app.post("/webchat/:id/message", webchat.message);
    // Not public: which sites loaded this widget is the owner's diagnostic, so it takes ordinary bearer auth.
    app.get("/webchat/:id/installs", webchat.installs);

    // The bug intake: reporter bundle, per-automation config, puzzle challenge, and the report ingest itself; exempt
    // from bearer auth, gated by origin allowlist or ingest key plus rate limit and daily ceiling.
    // The ingest answers immediately, since a crashing page is often seconds from unloading; the owner's inbox is the
    // non-public oRPC /issues surface.
    const intake = createIntakeRoutes(services);
    app.get("/intake/sdk.js", createSdkRoute());
    app.get("/intake/:id/config", intake.config);
    app.get("/intake/:id/challenge", intake.challenge);
    app.post("/intake/:id/report", intake.report);

    // Shared-access roster, gated by ownership rather than the operating gate other privileged routes use.
    const members = createMembersRoutes(services);
    app.get("/members", members.list);
    app.post("/members", members.add);
    app.delete("/members", members.remove);
    app.delete("/members/self", members.removeSelf);

    // The agent-proposed overlay Dockerfile: members read, the owner approves, rejects, or runtime-installs a line.
    const environment = createEnvironmentRoutes(services);
    app.get("/environment", environment.read);
    app.get("/environment/contents", environment.contents);
    app.post("/environment/approve", environment.approve);
    app.post("/environment/reject", environment.reject);
    app.post("/environment/runtime-install", environment.runtimeInstall);

    // Agent engines, beside /environment since both answer the same owner question: what is installed here.
    const engines = createEnginesRoutes(services);
    app.get("/engines", engines.view);
    app.post("/engines/channel", engines.channel);
    app.post("/engines/update", engines.update);
    app.post("/engines/revert", engines.revert);

    // The environment bundle: owner-only exports, plus the ticketed download the browser navigates to.
    const bundles = createBundleRoutes(services);
    app.get("/bundles", bundles.list);
    app.post("/bundles", bundles.start);
    app.delete("/bundles", bundles.remove);
    app.post("/bundles/ticket", bundles.ticket);
    app.get("/bundles/download", bundles.download);

    // The definition, outbound: `sandbox.toml` derived and diffed, and the workspace repo it names.
    const definition = createDefinitionRoutes(services);
    app.get("/definition", definition.derive);
    app.post("/definition/diff", definition.diff);
    app.get("/definition/workspace", definition.workspace);
    app.post("/definition/workspace/publish", definition.publish);

    // Arrivals: everything coming into this sandbox, through one preview-first pipeline.
    const arrivals = createArrivalRoutes(services);
    app.post("/arrivals/plan", arrivals.plan);
    app.get("/arrivals/hosts", arrivals.hosts);
    app.post("/arrivals/scan", arrivals.scan);
    app.post("/arrivals/apply", arrivals.apply);
    app.delete("/arrivals", arrivals.abandon);

    // An extension's prebuilt ESM bundle, and the backend namespace /x/<id>/* proxied verbatim to the backend host.
    app.get("/extensions/:id/bundle", createExtensionBundleRoute(services));
    app.all("/x/*", createBackendProxyRoute(services));

    // The capability setup gate, the `capabilities` CLI's two routes: `connectable` is discovery only, `ask` parks the
    // call on an owner-decided chat card.
    // Registered before the oRPC catch-all so the exact paths win over the /capabilities REST surface.
    const askRoutes = createCapabilityAskRoutes(services);
    app.get("/capabilities/connectable", askRoutes.connectable);
    app.post("/capabilities/ask", askRoutes.ask);

    // The wallet surface: `status`/`history` are reads, `fetch` is the one door money leaves through.
    // It parses the endpoint's x402 challenge, checks the owner's policy, parks non-standing spend on an approval card,
    // and has the platform sign; the key never enters this container.
    const walletRoutes = createWalletRoutes(services);
    app.get("/wallet/status", walletRoutes.status);
    app.post("/wallet/fetch", walletRoutes.fetch);
    app.get("/wallet/history", walletRoutes.history);

    // The child-agent surface: start a full agent on any connected provider, park for input, list this conversation's
    // children.
    // The gate is the arming recorded at plan time, since the agent token names the sandbox, never a persona; scoped
    // like `services`/`capabilities`.
    const childrenRoutes = createChildrenRoutes(services);
    app.post("/children/spawn", childrenRoutes.spawn);
    // What a child could be started on now, with each model's remaining allowance.
    app.get("/children/providers", childrenRoutes.providers);
    app.post("/children/wait", childrenRoutes.wait);
    app.post("/children/send", childrenRoutes.send);
    app.post("/children/answer", childrenRoutes.answer);
    app.get("/children", childrenRoutes.list);

    // The fleet read surface: which conversations exist, what one is, and which said a phrase, joined from the
    // registry, the record, the worktree composition and the phrase index.
    // Read-only, so it can be scoped to the agent token like `services`/`capabilities`, unlike `/agents`.
    const fleetRoutes = createFleetRoutes(services);
    app.get("/fleet", fleetRoutes.list);
    app.get("/fleet/:handle", fleetRoutes.show);

    // Realtime-listener control for an extension's gateway process: reconciles via /state, POSTs inbound events to
    // /dispatch, reports failures/status.
    // Reached with the per-boot panel token, like every other panel-process call.
    const listenerRoutes = createListenerRoutes(services);
    app.get("/listeners/:provider/state", listenerRoutes.state);
    app.post("/listeners/:provider/dispatch", listenerRoutes.dispatch);
    app.post("/listeners/:provider/failure", listenerRoutes.failure);
    app.post("/listeners/:provider/status", listenerRoutes.status);

    // CI webhook receiver, public, secret-gated in the handler; completed pipelines wake `ci` listener automations.
    app.post("/ci/webhook/:host", createCiWebhookRoute(services));

    // Desktop sync enrollment: the browser mints a pairing here, the agent redeems it at /system/authorized-key.
    const sync = createSyncRoutes(services);
    app.post("/system/sync/pair", sync.pair);

    // The peer doors: each device, browser and runner gets pairing, enrollment, roster, revoke, socket, MCP bridge.
    mountPeerRoutes(app, HOST_PEER, hostPeerRoutes(services));
    mountPeerRoutes(app, WEBEXT_PEER, webextPeerRoutes(services));
    mountPeerRoutes(app, RUNNER_PEER, runnerPeerRoutes(services));
    // A browser's two credential doors: `session` moves a site sign-in in, `lend` moves one back out.
    app.post("/system/webext/session", createWebExtSessionRoute(services));
    app.post("/system/webext/lend", createWebExtLendRoute(services));
    // A runner's settings push, then its git door and its credential doors.
    app.post("/system/runners/:id/definition/sync", createRunnerDefinitionSyncRoute(services));
    // The git door runners fetch and push through: stock smart HTTP off the real git dirs, per-request, own token.
    app.get("/system/runners/git/:repo/info/refs", createRunnerGitRefsRoute(services));
    app.post("/system/runners/git/:repo/git-upload-pack", createRunnerGitRpcRoute(services, "git-upload-pack"));
    app.post("/system/runners/git/:repo/git-receive-pack", createRunnerGitRpcRoute(services, "git-receive-pack"));
    // The credential doors: per-turn access tokens, mid-turn re-mints, translator behind the runner's own bearer.
    app.post("/system/runners/credentials", createRunnerCredentialsRoute(services));
    app.post("/system/runners/credentials/refresh", createRunnerCredentialRefreshRoute(services));
    app.all(`${runnerTranslatorPath}/*`, createRunnerTranslatorProxyRoute(services));
    // Control tokens: owner-minted, durable, revocable machine credentials.
    const controlTokens = createControlTokenRoutes(services);
    app.post("/system/control/tokens", controlTokens.mint);
    app.get("/system/control/tokens", controlTokens.list);
    app.delete("/system/control/tokens/:id", controlTokens.revoke);

    // Sign out every browser, and retire access for good; the latter stays repeatable after a partial attempt.
    app.post("/system/sessions/revoke", access.revokeSessions);
    app.post("/system/access/disable", access.disable);

    // Desktop sync's enrollment surface with the merged devices view beside it; exact-path doors are the agent's.
    app.post("/system/authorized-key", sync.enrollKey);
    app.get("/system/sync", sync.state);
    app.get("/system/devices", createDevicesRoute(services));
    app.post("/system/sync/report", sync.report);
    app.delete("/system/authorized-key", sync.revokeOwn);
    app.delete("/system/authorized-key/:machine", sync.revokeMachine);

    // Everything else flows through the oRPC handler at the root; registered last so /health matches first.
    app.all("/*", async (c) => {
        const result = await orpcHandler.handle(c.req.raw, { context: buildOrpcContext(c) });
        if (result.matched) {
            return result.response;
        }
        return c.notFound();
    });

    return app;
};
