import { REQUEST_ID_HEADER, type RouteMeta, sandboxRouteFor } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerFrom, ForbiddenError, PasskeyRequiredError } from "./auth/auth.js";
import { allowedOriginsOf, originAllowedBy } from "./auth/browser-origins.js";
import { createPasskeyRoutes } from "./auth/passkeys/passkeys.routes.js";
import { createAccessRoutes } from "./auth/access.routes.js";
import { createControlTokenRoutes } from "./auth/control-tokens.routes.js";
import { createMembersRoutes } from "./auth/members/members.routes.js";
import { memberRefusal } from "./auth/role-floor.js";
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
import { createSandboxesRoutes } from "./fleet/sandboxes.routes.js";
import { createWalletRoutes } from "./wallet/wallet.routes.js";
import { createFleetRoutes } from "./agents/recall/fleet.routes.js";
import { createChildrenRoutes } from "./agent/subagents/children.routes.js";
import { resolveHarnessCredentials } from "./agent/providers/harness-credentials.js";
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
import { createBrowserPrepareRoute } from "./browser/tools/browser-prepare.js";
import { HOST_PEER, hostPeerRoutes } from "./hosts/host-peer.js";
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
import { rawRouteServer } from "./raw-route-server.js";

// Only genuine server faults (5xx) are logged; expected ORPCErrors are the routes' normal control flow.
const logUnexpectedError = (services: Services, error: unknown): void => {
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return;
    }
    services.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "unhandled error");
};

// What a request is held to: the meta of the route it resolves to (sandbox-contract routes.ts), all defaults when no
// route serves it.
const policyOf = (c: Context<AppEnv>): RouteMeta => sandboxRouteFor(c.req.method, c.req.path)?.meta ?? {};

// The path the router will actually match: oRPC normalizes a trailing slash before dispatch, so a grant that matches a
// path itself must check the same normalized path. A root path stays `/`, repeated slashes collapse.
const routedPath = (path: string): string => path.replace(/\/+$/u, "") || "/";

// The HTTP API the browser drives directly; when services.auth is set, every route but a declared door verifies the
// caller's session.
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
        if (policyOf(c).stream === true) {
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
        if (policyOf(c).beforeBoot !== true) {
            await services.boot.converged;
        }
        return next();
    });

    // CORS is emitted in every auth mode, from the same allowlist the authorizer would use.
    // The local profile needs it too: its host serves the app from its own origin, so the browser preflights loopback
    // like any cross-origin call.
    // The same allowlist a passkey may be bound to (auth/origins.ts).
    const originAllowed = originAllowedBy(allowedOriginsOf(services.config.webOrigin));
    app.use(
        "*",
        cors({
            // The daemon is owner-driven from one origin, except the webchat widget, embedded on third-party sites:
            // reflect the caller's origin there, the route's own allowlist is the real gate.
            // Everywhere else this is an allowlist, never a wildcard, since /health answers a stranger with the sandbox
            // id the loopback port derives from.
            origin: (origin, c) => {
                if (policyOf(c).embedded === true) {
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
            const policy = policyOf(c);
            if (policy.auth === "door") {
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
                const caller = await authorize(bearerFrom(c.req.header("authorization")), c.req.header("x-intentic-connect") ?? undefined, {
                    enrolment: policy.enrolment === true,
                });
                c.set("identity", caller);
                // The role floor (auth/role-floor.ts) applies here, after authentication, in one place: a member below
                // a route's tier gets a 403 naming the tier, and a guest gets one for any door off its own list.
                // Owner-only routes still keep their own in-route gates besides; this floor only keeps a viewer
                // read-only and a collaborator off ship controls.
                const refused = memberRefusal(caller, c.req.method, c.req.path, c.req.query("path"));
                if (refused !== undefined) {
                    return c.json(refused, 403);
                }
            } catch (error) {
                // 403 is a verified identity that isn't the owner/member; 401 reads like any other unreachable daemon.
                if (error instanceof ForbiddenError) {
                    return c.json({ error: error.message }, 403);
                }
                // 428: the identity is welcome, the proof is not enough; the body says whether a passkey is held or
                // must first be added (the contract's PasskeyRequired).
                if (error instanceof PasskeyRequiredError) {
                    return c.json({ error: error.message, requires: "passkey", enrolled: error.enrolled }, 428);
                }
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    // Every raw route below is registered under its declaration, so none exists without a policy (raw-routes.ts).
    const serve = rawRouteServer(app);

    // The "is a daemon there" probe every flow uses (launch scripts, /setup, the browser's loopback probe).
    // The sandbox id lets a loopback probe confirm it reached this daemon, not an unrelated process; `boot` tells "not
    // answering" from "still converging".
    // `announce` is the one signal for whether this daemon reached the platform; ic reads it via docker exec.
    serve("GET /health", (c) =>
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
    serve("GET /workspace/raw", workspaceBytes.raw);
    serve("GET /workspace/thumb", workspaceBytes.thumb);
    serve("GET /workspace/media", workspaceBytes.media);
    serve("POST /workspace/upload", workspaceBytes.upload);
    serve("POST /workspace/upload-diff", workspaceBytes.uploadDiff);
    serve("POST /workspace/upload-archive", workspaceBytes.uploadArchive);

    // Browser credentials: the one-shot ticket the WebSocket upgrades redeem, minted over HTTP so auth can bind it.
    const access = createAccessRoutes(services);
    serve("POST /system/ws-ticket", access.wsTicket);

    // Interactive PTY over a WebSocket, paired with the `ws` server in bootstrap/daemon-listeners.ts; matched before the oRPC catch-all.
    serve("GET /system/terminal", createTerminalRoute(services));

    // Desktop sync's transport: this container's sshd as a byte stream, authorized via the ordinary grant table.
    serve("GET /system/sync/ssh", createSyncSshRoute(services));

    // A browser-kind capability's own Chromium: a WebSocket on the platform profile, same auth as the terminal.
    serve("GET /system/browser-profile", createBrowserProfileRoute(services));

    // Watch the browser the agent drives: the same screencast wire, attached to a live browser-* session.
    serve("GET /system/browser-view", createBrowserViewRoute(services));

    // Deploy-target enrollment (connect token) and the automation fire (own token).
    serve("POST /enroll", createEnrollRoute(services));
    serve("POST /automations/{id}/fire", createAutomationFireRoute(services));

    // The release gate: a pipeline runner POSTs here and waits for the verdict, authenticated by the workflow's own
    // minted gate token.
    // The only route in the daemon that holds a request open for the work it started.
    serve("POST /workflows/{id}/gate", createGateRoute(services));

    // The Visitor chat: widget bundle, per-automation config, bot challenge, the message ingest streaming its reply as
    // SSE, and the poll that collects a reply written after that stream closed.
    const webchat = createWebchatRoutes(services);
    serve("GET /webchat/widget.js", createWidgetRoute());
    serve("GET /webchat/{id}/config", webchat.config);
    serve("GET /webchat/{id}/challenge", webchat.challenge);
    serve("POST /webchat/{id}/message", webchat.message);
    // Replies written after the visitor's stream closed: an approved wake's, or a human's, written as the agent.
    serve("GET /webchat/{id}/messages", webchat.messages);
    // Which sites loaded this widget, the owner's diagnostic.
    serve("GET /webchat/{id}/installs", webchat.installs);

    // The bug intake: reporter bundle, per-automation config, puzzle challenge, and the report ingest itself.
    // The ingest answers immediately, since a crashing page is often seconds from unloading; the owner's inbox is the
    // non-public oRPC /issues surface.
    const intake = createIntakeRoutes(services);
    serve("GET /intake/sdk.js", createSdkRoute());
    serve("GET /intake/{id}/config", intake.config);
    serve("GET /intake/{id}/challenge", intake.challenge);
    serve("POST /intake/{id}/report", intake.report);

    // Shared-access roster, gated by ownership rather than the operating gate other privileged routes use.
    const members = createMembersRoutes(services);
    serve("GET /members", members.list);
    serve("POST /members", members.add);
    serve("DELETE /members", members.remove);
    serve("DELETE /members/self", members.removeSelf);

    // The agent-proposed overlay Dockerfile: members read, the owner approves, rejects, or runtime-installs a line.
    const environment = createEnvironmentRoutes(services);
    serve("GET /environment", environment.read);
    serve("GET /environment/contents", environment.contents);
    serve("POST /environment/approve", environment.approve);
    serve("POST /environment/reject", environment.reject);
    serve("POST /environment/runtime-install", environment.runtimeInstall);

    // Agent engines, beside /environment since both answer the same owner question: what is installed here.
    const engines = createEnginesRoutes(services);
    serve("GET /engines", engines.view);
    serve("POST /engines/channel", engines.channel);
    serve("POST /engines/update", engines.update);
    serve("POST /engines/revert", engines.revert);

    // The environment bundle: owner-only exports, plus the ticketed download the browser navigates to.
    const bundles = createBundleRoutes(services);
    serve("GET /bundles", bundles.list);
    serve("POST /bundles", bundles.start);
    serve("DELETE /bundles", bundles.remove);
    serve("POST /bundles/ticket", bundles.ticket);
    serve("GET /bundles/download", bundles.download);

    // The definition, outbound: `sandbox.toml` derived and diffed, and the workspace repo it names.
    const definition = createDefinitionRoutes(services);
    serve("GET /definition", definition.derive);
    serve("POST /definition/diff", definition.diff);
    serve("GET /definition/workspace", definition.workspace);
    serve("POST /definition/workspace/publish", definition.publish);

    // Arrivals: everything coming into this sandbox, through one preview-first pipeline.
    const arrivals = createArrivalRoutes(services);
    serve("POST /arrivals/plan", arrivals.plan);
    serve("GET /arrivals/hosts", arrivals.hosts);
    serve("POST /arrivals/scan", arrivals.scan);
    serve("POST /arrivals/apply", arrivals.apply);
    serve("DELETE /arrivals", arrivals.abandon);

    // An extension's prebuilt ESM bundle, and the backend namespace /x/<id>/* proxied verbatim to the backend host.
    serve("GET /extensions/{id}/bundle", createExtensionBundleRoute(services));
    serve("ALL /x/*", createBackendProxyRoute(services));

    // The capability setup gate, the `capabilities` CLI's two routes: `connectable` is discovery only, `ask` parks the
    // call on an owner-decided chat card.
    // Registered before the oRPC catch-all so the exact paths win over the /capabilities REST surface.
    const askRoutes = createCapabilityAskRoutes(services);
    serve("GET /capabilities/connectable", askRoutes.connectable);
    serve("POST /capabilities/ask", askRoutes.ask);

    // The `sandboxes` CLI: the owner's other sandboxes, and the one door a new one is created through. `/sandboxes`
    // rather than `/fleet`, which the conversation-fleet reads already own.
    const sandboxRoutes = createSandboxesRoutes(services);
    serve("GET /sandboxes", sandboxRoutes.list);
    serve("POST /sandboxes", sandboxRoutes.create);

    // The wallet surface: `status`/`history` are reads, `fetch` is the one door money leaves through.
    // It parses the endpoint's x402 challenge, checks the owner's policy, parks non-standing spend on an approval card,
    // and has the platform sign; the key never enters this container.
    const walletRoutes = createWalletRoutes(services);
    serve("GET /wallet/status", walletRoutes.status);
    serve("POST /wallet/fetch", walletRoutes.fetch);
    serve("GET /wallet/history", walletRoutes.history);

    // The child-agent surface: start a full agent on any connected provider, park for input, list this conversation's
    // children.
    // The gate is the arming recorded at plan time, since the agent token names the sandbox, never a persona; scoped
    // like `services`/`capabilities`.
    const childrenRoutes = createChildrenRoutes(services);
    serve("POST /children/spawn", childrenRoutes.spawn);
    // What a child could be started on now, with each model's remaining allowance.
    serve("GET /children/providers", childrenRoutes.providers);
    serve("POST /children/wait", childrenRoutes.wait);
    serve("POST /children/send", childrenRoutes.send);
    serve("POST /children/answer", childrenRoutes.answer);
    serve("GET /children", childrenRoutes.list);

    // The fleet surface: which conversations exist, what one is, which said a phrase — joined from the registry, the
    // record, the worktree composition and the phrase index — and saying something to one of them.
    // Scoped to the agent token like `services`/`capabilities`, unlike `/agents`: the reads cannot change anything,
    // and the one write only puts words in front of another conversation, which a person can do by typing.
    const fleetRoutes = createFleetRoutes(services);
    serve("GET /fleet", fleetRoutes.list);
    serve("POST /fleet/message", fleetRoutes.message);
    serve("GET /fleet/{handle}", fleetRoutes.show);

    // Realtime-listener control for an extension's gateway process: reconciles via /state, POSTs inbound events to
    // /dispatch, reports failures/status.
    // Reached with the per-boot panel token, like every other panel-process call.
    const listenerRoutes = createListenerRoutes(services);
    serve("GET /listeners/{provider}/state", listenerRoutes.state);
    serve("POST /listeners/{provider}/dispatch", listenerRoutes.dispatch);
    serve("POST /listeners/{provider}/failure", listenerRoutes.failure);
    serve("POST /listeners/{provider}/status", listenerRoutes.status);

    // CI webhook receiver, secret-gated in the handler; completed pipelines wake `ci` listener automations.
    serve("POST /ci/webhook/{host}", createCiWebhookRoute(services));

    // Desktop sync enrollment: the browser mints a pairing here, the agent redeems it at /system/authorized-key.
    const sync = createSyncRoutes(services);
    serve("POST /system/sync/pair", sync.pair);

    // The peer doors: each device, browser and runner gets pairing, enrollment, roster, revoke, socket, MCP bridge.
    mountPeerRoutes(serve, HOST_PEER, hostPeerRoutes(services));
    mountPeerRoutes(serve, WEBEXT_PEER, webextPeerRoutes(services));
    mountPeerRoutes(serve, RUNNER_PEER, runnerPeerRoutes(services));
    // A turn's browser router asking for one profile's spawn spec, on the first call that names it.
    serve("POST /system/browser/prepare", createBrowserPrepareRoute(services));
    // A browser's two credential doors: `session` moves a site sign-in in, `lend` moves one back out.
    serve("POST /system/webext/session", createWebExtSessionRoute(services));
    serve("POST /system/webext/lend", createWebExtLendRoute(services));
    // A runner's settings push, then its git door and its credential doors.
    serve("POST /system/runners/{id}/definition/sync", createRunnerDefinitionSyncRoute(services));
    // The git door runners fetch and push through: stock smart HTTP off the real git dirs, per-request, own token.
    serve("GET /system/runners/git/{repo}/info/refs", createRunnerGitRefsRoute(services));
    serve("POST /system/runners/git/{repo}/git-upload-pack", createRunnerGitRpcRoute(services, "git-upload-pack"));
    serve("POST /system/runners/git/{repo}/git-receive-pack", createRunnerGitRpcRoute(services, "git-receive-pack"));
    // The credential doors: per-turn access tokens, mid-turn re-mints, translator behind the runner's own bearer.
    serve(
        "POST /system/runners/credentials",
        createRunnerCredentialsRoute(services, (input) => resolveHarnessCredentials(services, input)),
    );
    serve("POST /system/runners/credentials/refresh", createRunnerCredentialRefreshRoute(services));
    serve("ALL /system/runners/translator/*", createRunnerTranslatorProxyRoute(services));
    // Control tokens: owner-minted, durable, revocable machine credentials.
    const controlTokens = createControlTokenRoutes(services);
    serve("POST /system/control/tokens", controlTokens.mint);
    serve("GET /system/control/tokens", controlTokens.list);
    serve("DELETE /system/control/tokens/{id}", controlTokens.revoke);

    // Passkeys: each member's own, the anonymous sign-in doors, the owner's require switch and its recovery codes.
    const passkeys = createPasskeyRoutes(services);
    serve("GET /system/passkeys", passkeys.list);
    serve("POST /system/passkeys/register/options", passkeys.registerOptions);
    serve("POST /system/passkeys/register", passkeys.register);
    serve("POST /system/passkeys/assert/options", passkeys.assertOptions);
    serve("POST /system/passkeys/assert", passkeys.assert);
    serve("POST /system/passkeys/policy", passkeys.setPolicy);
    serve("POST /system/passkeys/recovery", passkeys.regenerateRecovery);
    serve("DELETE /system/passkeys/{id}", passkeys.remove);
    serve("POST /system/session/recover", passkeys.recover);

    // Sign out every browser, and retire access for good; the latter stays repeatable after a partial attempt.
    serve("POST /system/sessions/revoke", access.revokeSessions);
    serve("POST /system/access/disable", access.disable);

    // Desktop sync's enrollment surface; exact-path doors are the agent's. The merged devices view is a contract
    // route (system.devices), so it arrives through the oRPC handler below.
    serve("POST /system/authorized-key", sync.enrollKey);
    serve("GET /system/sync", sync.state);
    serve("POST /system/sync/report", sync.report);
    serve("DELETE /system/authorized-key", sync.revokeOwn);
    serve("DELETE /system/authorized-key/{machine}", sync.revokeMachine);

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
