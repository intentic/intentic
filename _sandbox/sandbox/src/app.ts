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
import { createPoolRoutes } from "./platform/pool/pool.routes.js";
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

// Only genuine server faults (5xx) are logged; expected ORPCErrors (NOT_FOUND/BAD_REQUEST/…) are the routes'
// normal control flow and would be noise.
const logUnexpectedError = (services: Services, error: unknown): void => {
    if (error instanceof ORPCError && error.code !== "INTERNAL_SERVER_ERROR") {
        return;
    }
    services.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, "unhandled error");
};

// The webhook fire route for event automations, its callers are external systems, so it's exempt from the
// bearer middleware and authenticated by the automation's own token instead (see the route).
const eventFirePath = /^\/automations\/[^/]+\/fire$/;

/* The Front Desk's public surface, its callers are anonymous website visitors (no Google token), so these are
 * exempt from the bearer middleware and gated by the automation's origin allowlist + rate limit + bot check
 * instead (see webchat/webchat.routes.ts).
 *
 * This is the WHOLE list of what a stranger can reach on this daemon, so it is one predicate rather than a
 * constant per route: the set IS the boundary, and a boundary spread across four names is one somebody widens
 * by accident. `widget.js` is the only fixed path, the rest are per-automation. */
const webchatPublicPath = (path: string): boolean => path === "/webchat/widget.js" || /^\/webchat\/[^/]+\/(message|config|challenge)$/.test(path);

/* The bug intake's public surface, the daemon's second anonymous door and the same shape as the one above: a
 * stranger's browser (or a phone, or a server) with no Google token, gated instead by the automation's origin
 * allowlist or its ingest key, a per-client rate window and a daily ceiling (see issues/intake.routes.ts).
 *
 * A SEPARATE PREFIX FROM `/issues`, which is the OWNER's inbox and stays behind the bearer middleware. The two
 * are keyed by different things, an automation's public id out here, an issue's fingerprint in there, and one
 * prefix covering both is how a rule gets widened by accident. `sdk.js` is the only fixed path. */
const intakePublicPath = (path: string): boolean => path === "/intake/sdk.js" || /^\/intake\/[^/]+\/(report|config|challenge)$/.test(path);

/* THE PATH THE ROUTER WILL ACTUALLY MATCH, which is not always the one the client typed, and the gap between
 * the two is a way through every path-shaped rule in this file.
 *
 * Hono's `c.req.path` is the request's path verbatim; the oRPC handler behind the catch-all normalizes a
 * trailing slash before it dispatches. So `POST /capabilities/probe/` failed every `…probe$` test in the grant
 * table and then ran the probe handler anyway — measured, 200 with a real dial verdict, on the one route the
 * panel grant exists to refuse. Every rule that anchors on `$` had the same hole, allow-rules included; those
 * merely fail closed, which is why only the denials ever showed it.
 *
 * Normalizing HERE rather than in each predicate is the point: the middleware asks one question about a
 * request, so it should ask it about one path. A root request stays `/`, and repeated slashes collapse, since
 * `//capabilities/probe//` is the same dispatch. */
const routedPath = (path: string): string => path.replace(/\/+$/u, "") || "/";

// The CI pipeline webhook receiver, its callers are github/gitlab delivery agents (no Google token), so it's
// exempt from the bearer middleware and gated by the per-sandbox webhook secret instead (github signs the
// body, gitlab echoes the token, see ci/webhook.routes.ts).
const ciWebhookPath = /^\/ci\/webhook\/[^/]+$/;

// The release gate, its callers are pipeline runners (no Google token, and no Origin either, which is why it
// cannot ride the Front Desk's allowlist), so it's exempt from the bearer middleware and gated by the workflow's
// own minted gate token instead (see workflows/gate.routes.ts).
const gatePath = /^\/workflows\/[^/]+\/gate$/;

/* THE PEER DOORS (peers/), each exempt from the bearer middleware because none of their callers has a Google
 * identity to present: a connected device, a connected browser and a runner all dial in with their enrollment
 * token in the first frame (`connect`) and redeem a one-time pairing at `enroll`; the MCP bridges carry the
 * per-boot bridge token instead. Anchored per segment so none admits a route that merely starts the same way. */
const PEER_DOORS = [HOST_PEER, WEBEXT_PEER, RUNNER_PEER];
const peerPublicPath = (path: string): boolean => PEER_DOORS.some((door) => path === peerConnectPath(door.slug) || path === peerEnrollPath(door.slug));
const peerMcpPaths = PEER_DOORS.flatMap((door) => (door.mcp === undefined ? [] : [peerMcpPath(door.slug)]));

// A connected BROWSER's two credential doors, exempt for the same reason: `session` and `lend` carry the
// extension's own durable token as a bearer, which the routes verify themselves (webext.routes.ts). They are a
// pair pointing opposite ways: `session` takes a site's sign-in from the person's browser into a sandbox
// profile, `lend` takes one back out for a step no remote browser can perform.
const webextCredentialPath = (path: string): boolean => path === "/system/webext/session" || path === "/system/webext/lend";

// A RUNNER's further doors: its durable token as a bearer the git routes verify themselves
// (runner-git.routes.ts), and the credential doors. See runners/ and docs/remote-runners-plan.md (workspace root).
const runnerGitPath = /^\/system\/runners\/git\/[^/]+\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;
const runnerPublicPath = (path: string): boolean =>
    path === "/system/runners/credentials" ||
    path === "/system/runners/credentials/refresh" ||
    path.startsWith("/system/runners/translator/") ||
    runnerGitPath.test(path);

/* The routes that answer BEFORE the boot chain converges (services.boot, driven by main.ts).
 *
 * The liveness probe and the /events stream lead the list because they are how the boot is OBSERVED: /health
 * carries the progress snapshot for the launch scripts and the loopback probe, /events streams each transition
 * to the browser, and between them a browser can wait visibly instead of firing a workspace's worth of reads
 * at routes that would only park them. The WebSocket upgrades follow, their sessions live outside the
 * boot-converged state entirely.
 *
 * /system/session and /system/presence are exempt for the same reason, arrived at from the opposite direction:
 * both are boot-independent (the session secret lives on /history, the roster is in memory), and parking the
 * session exchange left a browser with no stored session unable to open the very stream that reports the boot
 *, the failure mode where clearing site data "fixed" a sandbox that was only ever starting up.
 *
 * Everything else reads state a boot step builds (registry, git dirs, claude session links), so it waits. */
// Long-lived streams, exempt from the request timer below. Each is SUPPOSED to stay open: /events for the
// life of a tab, an attach for the life of a turn, so timing them would file every healthy connection as the
// slowest thing the daemon ever did and bury the requests that genuinely stalled. The other event-iterator
// routes (a capability install, an intentic run) are bounded operations whose duration is worth knowing.
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
    /* Every peer door's socket: a connected device reconnects on its own backoff, which a booting daemon would
     * otherwise park just long enough to look like an outage on the card, and a browser's has more at stake in
     * the parking: an MV3 service worker is killed after ~30s of silence, so a socket held open waiting for a
     * boot step is a socket Chrome shuts. None of them needs anything the boot chain builds. */
    ...PEER_DOORS.map((door) => peerConnectPath(door.slug)),
]);

// The HTTP API the browser drives DIRECTLY over the sandbox's own Cloudflare tunnel. When services.auth is set
// the daemon verifies the owner's Google ID token on every route but /health (it owns its own auth). No auth
// only in tests or the host-internal server preview. All routes are oRPC except the plain /health and binary
// /workspace/raw, registered before the catch-all.
//
// services.boot is the boot gate: the listeners come up the moment the process can serve so a restart stops
// reading as an outage, and every data route awaits the boot chain instead of racing it, a request that lands
// early waits a few seconds where it used to get connection-refused for the whole boot.
export const createApp = (services: Services): Hono<AppEnv> => {
    const orpcHandler = new OpenAPIHandler(createRouter(services), {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    // A client that vanished mid-request (tab closed, a cancelled query, a dropped tunnel hop) leaves
                    // the node request stream aborted, and node-server's fast path rejects a read on a disturbed
                    // stream, so oRPC's input decode throws `TypeError: Body is unusable`. Not an incident: oRPC
                    // downgrades it to a 400 that goes to a socket nobody is holding. The window is real because the
                    // bearer middleware awaits `authorize` (JWKS verify + owner read) before the body is ever read,
                    // so every in-flight POST the browser cancels during a busy stretch lands here.
                    if (options.request.signal?.aborted !== true) {
                        logUnexpectedError(services, error);
                    }
                    throw error;
                }
            },
        ],
    });

    const app = new Hono<AppEnv>();

    /* Response hardening, above everything so it covers the error paths too. The daemon serves JSON and the
     * occasional raw workspace file, so most of this set is inert here, it is on for the two that are not:
     * `nosniff`, because /workspace/raw returns whatever bytes are on disk under a by-extension content type,
     * and `Referrer-Policy`, because the sandbox's own hostname carries its id and should not ride outbound
     * navigations from anything this origin serves.
     *
     * Cross-Origin-Resource-Policy is the one default that has to go: /webchat/widget.js is loaded as a plain
     * <script> from arbitrary third-party sites, which is precisely the no-cors request CORP blocks, leaving
     * it on would take every embedded Front Desk down. (COEP is off for the same family of reasons.) */
    app.use("*", secureHeaders({ crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));

    /* Outermost: what the BROWSER waited for. Every other measurement in this daemon times a piece of the
     * work; this one times the answer, which is the only number the user's complaint is actually about, and
     * the only one that also contains the parts nothing else sees (the boot gate below, auth's JWKS verify,
     * oRPC's zod validation of a six-figure change list, the serialization of the response).
     *
     * A "slow git" report that lands here at 4s with `git.scan` at 300ms is a completely different bug from
     * one where the two agree, and until this line existed there was no way to tell those apart.
     *
     * The streams are exempt: /events and the agent attach are long-lived by design, so timing them would log
     * every healthy connection as the slowest thing the daemon does. */
    app.use("*", async (c, next) => {
        if (STREAM_PATHS.has(c.req.path)) {
            return next();
        }
        const from = process.hrtime.bigint();
        await next();
        // The browser's own id for this call, echoed onto the line that served it. This is the half of the
        // correlation the daemon owns: with it, "the panel stuttered" and "slow http.request" are one grep
        // apart instead of a guess by timestamp on a sandbox serving several a second. Absent for every caller
        // that is not our web app (the CLI, an extension's own fetch, curl), which is why it is spread.
        const requestId = c.req.header(REQUEST_ID_HEADER);
        services.perf.record("http.request", Number(process.hrtime.bigint() - from) / 1e6, {
            method: c.req.method,
            path: c.req.path,
            status: c.res.status,
            ...(requestId !== undefined ? { requestId } : {}),
        });
    });

    // The boot gate, first so nothing below runs against half-built state. Waiting is deliberate: the caller
    // already retried through the whole connection-refused window this replaces, so holding the request the
    // last few seconds of a boot is strictly less waiting. Read per request, never captured, a tracker whose
    // chain main() declares AFTER the app is built still gates the requests that arrive next, and one that
    // declared nothing (tests, the host-internal preview) resolves at once.
    app.use("*", async (c, next) => {
        if (!READY_EXEMPT.has(c.req.path)) {
            await services.boot.converged;
        }
        return next();
    });

    /* CORS is emitted in EVERY auth mode, from the same allowlist the authorizer would use. It used to live
     * inside the auth block below, because the only authless daemons were tests and the host-internal preview
     *, same-origin callers that never trip CORS. The local profile broke that assumption: its host serves
     * the app from its own origin (an editor webview is one), so the browser preflights loopback like any
     * cross-origin call, and a daemon that emits nothing is unreachable from the very UI it exists to serve.
     * The allowlist reasoning is identical with or without auth, see the /health note below. */
    const allowOrigins = services.config.webOrigin
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== "");
    /* An allowlist entry may name a FAMILY: `https://*.example.net` admits any single label in the wildcard
     * position. Editor webviews are why, a webview's origin is minted per session from a fixed suffix, so no
     * exact spelling can be written down ahead of time. Still an allowlist, never a wildcard: the scheme and
     * the suffix are pinned, only one label floats, and the entry is the operator's own explicit config. */
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
            /* The daemon is owner-driven from one origin, except the web-chat widget, which is embedded on
             * arbitrary third-party sites. Reflect the caller's origin for /webchat so a legit widget isn't
             * browser-blocked; the route's own allowedOrigins check is the real gate there.
             *
             * Everywhere else this is an ALLOWLIST, never a wildcard, and the reason is /health. CORS buys
             * nothing on a route that checks a bearer, a stranger has no token to send, but /health
             * deliberately checks nothing and answers with the sandbox id, and the loopback listener's port
             * is derived from that id (@intentic/sandbox-run localDaemonPort). Under `*` any page in the
             * user's browser could walk that port range, read the id, and derive every preview hostname the
             * sandbox publishes. An unmatched origin gets no ACAO header, so the browser refuses the read. */
            origin: (origin, c) => {
                if (webchatPublicPath(c.req.path) || intakePublicPath(c.req.path)) {
                    return origin ?? "*";
                }
                // Reflect only a match (exact, or one family entry's single floating label): returning the
                // list's first entry for a foreign origin would hand the browser a header naming someone
                // else, which it correctly ignores, but it also hides the misconfiguration. null ⇒ no
                // header at all, which is the honest answer.
                return originAllowed(origin) ? origin : null;
            },
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            // REQUEST_ID_HEADER rides here too: a header the preflight does not allow is one the browser
            // silently drops, which would leave the daemon's side of the correlation permanently empty.
            allowHeaders: ["authorization", "content-type", "x-intentic-connect", "x-intentic-base-hash", REQUEST_ID_HEADER],
            maxAge: 600,
        }),
    );

    if (services.auth !== undefined) {
        const authorize = services.auth.authorize;
        // Built once: the secrets are per-boot and the stores are already live, so nothing here is per-request.
        const grants = grantsOf({
            panelToken: services.panelToken,
            agentToken: services.agentToken,
            controlTokens: services.controlTokens,
            verifySync: (presented, checkedIn) => verifySyncToken(services.config.historyRoot, presented, checkedIn),
            verifyExtension: (presented) => services.extensionBackend.verifyExtensionToken(presented),
        });
        app.use("*", async (c, next) => {
            // /system/terminal is a WebSocket upgrade: the browser can't set an Authorization header on it, so
            // the terminal route authorizes the token from the query string itself (see createTerminalRoute).
            /* /system/authorized-key is the desktop-sync AGENT's door, and it carries no bearer: the POST is
             * redeemed with a one-time pairing token the handler checks itself, and the DELETE is the same
             * agent self-revoking with its own sync token. Exact-path, so the owner's per-machine revoke
             * (/system/authorized-key/:machine) is NOT exempt — it is an owner acting in a browser, and it goes
             * through this middleware and then its own owner check like every other revoke. */
            if (
                c.req.path === "/health" ||
                c.req.path === "/system/terminal" ||
                // /system/browser-profile is a WebSocket upgrade too, it authorizes token+connect from the query
                // string itself (see createBrowserProfileRoute), same as /system/terminal.
                c.req.path === "/system/browser-profile" ||
                // …and so is /system/browser-view, the same screencast pointed at the browser the AGENT drives.
                c.req.path === "/system/browser-view" ||
                // /workspace/media is fetched by a <video>/<audio> element, which cannot carry a header either.
                // It checks its own path-scoped ticket (auth/media-tickets.ts), a strictly narrower grant than
                // the bearer, and the route refuses outright without one.
                c.req.path === "/workspace/media" ||
                // /bundles/download is NAVIGATED to, so the browser's own download manager streams the bytes to
                // disk, and a navigation carries no Authorization header either. Same containment as the media
                // route: its own ticket, minted by an owner-gated POST and scoped to the one bundle it names.
                c.req.path === "/bundles/download" ||
                c.req.path === "/enroll" ||
                c.req.path === "/system/authorized-key" ||
                // Account deletion must be repeatable after a partial attempt already disabled this daemon.
                // Its handler performs the one owner check allowed through the permanent retirement marker.
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
            /* The non-bearer credentials, a panel's backend, the in-container `vpn` CLI, a control token
             * (the ACP bridge, and whatever drives this sandbox from outside), the desktop-sync agent. One
             * table in auth/grants.ts says what each reaches; this loop is the only place any of them is
             * admitted. Identity stays unset for all of them (documented-legal, the panel-token precedent):
             * each acts as the owner's tool rather than as a member. A grant that can NAME its holder (a
             * control token, minted with a label) hands back a principal, stashed for the handlers that
             * attribute work (auth/principal.ts). */
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
                /* The role floor (auth/role-floor.ts), after authentication and in one place: a member below a
                 * route's tier gets a 403 that NAMES the tier, so the browser can render "ask a maintainer"
                 * instead of a bare refusal. The owner-only routes keep their in-route gates besides, this
                 * floor is what keeps a viewer read-only and a collaborator off the ship controls. */
                const floor = routeFloor(c.req.method, c.req.path);
                if (!roleAtLeast(caller.role, floor)) {
                    return c.json({ error: `${floor} access required`, floor }, 403);
                }
            } catch (error) {
                // 403 = verified identity that isn't the owner/a member, the browser renders "no access" for it,
                // distinct from 401 (missing/invalid token), which it treats like any other unreachable daemon.
                if (error instanceof ForbiddenError) {
                    return c.json({ error: error.message }, 403);
                }
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    /* Unauthenticated by design (the gate above exempts it), it is the "is a daemon there" probe every flow
     * makes: the launch scripts' readiness loop, /setup's attach check, and the browser's LOOPBACK PROBE.
     *
     * That last one is why the sandbox id is here. A browser on the same machine dials 127.0.0.1 at a port
     * derived from this sandbox's id (@intentic/sandbox-run localDaemonPort) instead of going out to
     * Cloudflare and back, but a port is not an identity: a second sandbox, or an unrelated process, can be
     * behind it. Answering with the id lets the probe prove it reached THIS daemon before routing a session's
     * traffic at it; a mismatch means the browser silently keeps using the tunnel. The id is already the
     * leading label of the sandbox's public hostname, so naming it here discloses nothing new.
     *
     * `boot` rides along for the callers that poll this before a stream exists, the launch scripts' readiness
     * loop and /setup's attach check, so "not answering yet" and "answering, still converging" stop looking
     * alike from the outside. Purely additive: `ok` and `sandboxId` are unchanged. */
    /* `announce` rides along for the one probe that can see it: the browser and the platform each know their
     * own half of the setup chain, but whether THIS DAEMON reached the platform is knowable only in here,
     * ic's postflight and doctor read it via docker exec, and name that link when it is the broken one. */
    app.get("/health", (c) =>
        c.json({
            ok: true,
            sandboxId: sandboxIdFromToken(services.config.connectToken),
            // Which posture answers (see platform/profile.ts), on the liveness probe because a client needs
            // it before any authenticated read: a local daemon has no auth to establish at all.
            profile: services.config.sandbox.profile,
            boot: services.boot.progress(),
            announce: services.announcer.status(),
            // …and its other half: whether this sandbox's PUBLIC address answers, which the box establishes by
            // probing itself. Same readers, same reason, except that a broken tunnel is the one failure a
            // caller cannot learn any other way, because every other route to the answer runs through it.
            reach: services.reach.status(),
            // HOW the world gets here: through a tunnel this daemon dials, directly (a Fly machine the
            // platform's edge replays to, no intentic process on the path), or over loopback alone. The
            // address is the same in the first two cases, so nothing but this can tell them apart.
            reachedBy: reachPosture({
                url: services.config.ingress.url,
                grant: services.config.sandbox.grant,
                frontDoor: profileTraits(services.config).extraListeners,
                vm: services.config.sandbox.vm,
            }).by,
        }),
    );

    // The same bytes, for one side of a diff rather than a file in the tree, an image the review surfaces can
    // only flag as `binary` over the JSON contract. Mounted here beside /workspace/raw for the same reason it
    // is not an oRPC route: the body is a streamed binary, not JSON.
    app.route("/", createDiffRawRoute(services));

    // The composer's voice input, a WAV utterance in, its text out. A byte route for the same reason as its
    // neighbours: the JSON contract has no business carrying audio (see speech/speech.routes.ts).
    app.route("/", createSpeechRoute(services));

    /* The workspace's byte routes (workspace/workspace-bytes.routes.ts): the raw file read, the ranged media
     * read a <video> talks to, and the three upload doors. Off oRPC because their bodies are streamed bytes,
     * and registered before the catch-all for the same reason as /health. */
    const workspaceBytes = createWorkspaceBytesRoutes(services);
    app.get("/workspace/raw", workspaceBytes.raw);
    app.get("/workspace/media", workspaceBytes.media);
    app.post("/workspace/upload", workspaceBytes.upload);
    app.post("/workspace/upload-diff", workspaceBytes.uploadDiff);
    app.post("/workspace/upload-archive", workspaceBytes.uploadArchive);

    /* Browser credentials (auth/access.routes.ts): the one-shot ticket the three WebSocket upgrades below
     * redeem, minted here over ordinary HTTP so the bearer middleware establishes the identity it binds to. */
    const access = createAccessRoutes(services);
    app.post("/system/ws-ticket", access.wsTicket);

    // Interactive PTY over a WebSocket. Paired with the `ws` server passed to serve() in main.ts (node-server's
    // upgradeWebSocket drives it); registered before the oRPC catch-all so the upgrade matches here.
    app.get("/system/terminal", createTerminalRoute(services));

    // Desktop sync's transport: this container's sshd, as a byte stream over the same HTTPS surface the
    // workspace is served on (platform/sync-ssh.ts). Authorized by the enrolled machine's sync token through
    // the ordinary grant table, a Node client can set a header, so this needs no query-string ticket.
    app.get("/system/sync/ssh", createSyncSshRoute(services));

    // A `browser`-kind capability's own Chromium, in the owner's hands: a WebSocket that screencasts the
    // platform's persistent profile, to sign into, or to use the connected account by hand (see
    // createBrowserProfileRoute). Same shared `ws` server + query-string auth as the terminal.
    app.get("/system/browser-profile", createBrowserProfileRoute(services));

    // Watch the browser the AGENT is driving, the same screencast wire as the profile window, attached to a
    // live `browser-*` session instead of the platform's own profile (see createBrowserViewRoute).
    app.get("/system/browser-view", createBrowserViewRoute(services));

    // Deploy-target enrollment from the connect-host script, gated by the connect token alone
    // (inventory/enroll.routes.ts), and the webhook fire for event automations, gated by the automation's own
    // token (automations/fire.routes.ts). Both are exempt from the bearer middleware above.
    app.post("/enroll", createEnrollRoute(services));
    app.post("/automations/:id/fire", createAutomationFireRoute(services));

    /* The release gate: a pipeline runner POSTs here to run a workflow and WAIT for its verdict. Public
     * (gatePath above), authenticated by the workflow's own minted gate token, and the only route in the
     * daemon that holds a request open for the work it started, see workflows/gate.routes.ts for why. */
    app.post("/workflows/:id/gate", createGateRoute(services));

    /* The Front Desk: the embeddable widget bundle, the per-automation config it renders itself from, its bot
     * challenge, and the message ingest whose reply streams back as SSE. All four are exempt from the bearer
     * middleware (visitors have no Google token) and gated instead by the automation's origin allowlist, a
     * per-conversation rate limit and the configured bot check. Registered before the oRPC catch-all, like
     * /automations/:id/fire. `widget.js` is declared first so it can't be shadowed by the :id routes. */
    const webchat = createWebchatRoutes(services);
    app.get("/webchat/widget.js", createWidgetRoute());
    app.get("/webchat/:id/config", webchat.config);
    app.get("/webchat/:id/challenge", webchat.challenge);
    app.post("/webchat/:id/message", webchat.message);
    // NOT public (absent from webchatPublicPath above): which sites have loaded this Front Desk's widget is the
    // owner's install diagnostic, so it takes the ordinary bearer middleware like every other app route.
    app.get("/webchat/:id/installs", webchat.installs);

    /* The bug intake: the reporter's bundle, the per-automation config it renders itself from, its puzzle for
     * written reports, and the ingest itself. Exempt from the bearer middleware for the Front Desk's reason
     * (nobody reporting a crash has a Google token) and gated instead by the origin allowlist or the ingest key,
     * a per-client rate window and a daily ceiling. `sdk.js` is declared first so it cannot be shadowed by the
     * :id routes.
     *
     * The ingest answers IMMEDIATELY and decides about waking anyone afterwards, unlike the chat above: the page
     * that is reporting a crash is often seconds from unloading, and there is nothing for it to wait on. The
     * owner's inbox for what lands here is the oRPC /issues surface, which is not public. */
    const intake = createIntakeRoutes(services);
    app.get("/intake/sdk.js", createSdkRoute());
    app.get("/intake/:id/config", intake.config);
    app.get("/intake/:id/challenge", intake.challenge);
    app.post("/intake/:id/report", intake.report);

    // The shared-access roster (auth/members.routes.ts), gated by ownership rather than the maintainer-
    // equivalent operating gate every other privileged route below uses (auth/owner-gates.ts).
    const members = createMembersRoutes(services);
    app.get("/members", members.list);
    app.post("/members", members.add);
    app.delete("/members", members.remove);
    app.delete("/members/self", members.removeSelf);

    // The agent-proposed overlay Dockerfile (environment/environment.routes.ts): members read, the owner
    // approves, rejects, or answers one runtime-install line.
    const environment = createEnvironmentRoutes(services);
    app.get("/environment", environment.read);
    app.get("/environment/contents", environment.contents);
    app.post("/environment/approve", environment.approve);
    app.post("/environment/reject", environment.reject);
    app.post("/environment/runtime-install", environment.runtimeInstall);

    // The agent engines (engines/engines.routes.ts), beside /environment because they answer the same owner
    // question — what is installed here.
    const engines = createEnginesRoutes(services);
    app.get("/engines", engines.view);
    app.post("/engines/channel", engines.channel);
    app.post("/engines/update", engines.update);
    app.post("/engines/revert", engines.revert);

    // The environment bundle (portability/bundle.routes.ts): owner-only exports as artifacts, and the ticketed
    // download the browser navigates to (exempt from the bearer middleware above).
    const bundles = createBundleRoutes(services);
    app.get("/bundles", bundles.list);
    app.post("/bundles", bundles.start);
    app.delete("/bundles", bundles.remove);
    app.post("/bundles/ticket", bundles.ticket);
    app.get("/bundles/download", bundles.download);

    // The definition, outbound (portability/definition.routes.ts): `sandbox.toml` derived and diffed, and the
    // workspace repo it names.
    const definition = createDefinitionRoutes(services);
    app.get("/definition", definition.derive);
    app.post("/definition/diff", definition.diff);
    app.get("/definition/workspace", definition.workspace);
    app.post("/definition/workspace/publish", definition.publish);

    // Arrivals (portability/arrival.routes.ts): everything coming INTO this sandbox, through one preview-first
    // pipeline.
    const arrivals = createArrivalRoutes(services);
    app.post("/arrivals/plan", arrivals.plan);
    app.get("/arrivals/hosts", arrivals.hosts);
    app.post("/arrivals/scan", arrivals.scan);
    app.post("/arrivals/apply", arrivals.apply);
    app.delete("/arrivals", arrivals.abandon);

    // An extension's prebuilt ESM bundle, raw JS bytes (extensions/extension-bundle.routes.ts), and the
    // extension backend namespaces /x/<id>/* proxied verbatim to the backend host
    // (extensions/backend/backend-proxy.routes.ts).
    app.get("/extensions/:id/bundle", createExtensionBundleRoute(services));
    app.all("/x/*", createBackendProxyRoute(services));

    // The creator pool's metered services, relayed to the platform (platform/pool.routes.ts).
    const pool = createPoolRoutes(services);
    app.get("/pool/services", pool.catalog);
    app.post("/pool/wanted", pool.wanted);
    app.post("/pool/services/:slug/run", pool.run);

    /* The capability setup gate, the `capabilities` CLI's two routes (capabilities/ask.routes.ts).
     * `connectable` is discovery (every card, whether it's connected, names only, never config); `ask` parks
     * the agent's call on an owner-decided card in chat, exactly the consent shape the priced-services gate
     * above enforces: the model may ask, and only the owner's click makes anything happen. Registered before
     * the oRPC catch-all so the exact paths win over the /capabilities REST surface. */
    const askRoutes = createCapabilityAskRoutes(services);
    app.get("/capabilities/connectable", askRoutes.connectable);
    app.post("/capabilities/ask", askRoutes.ask);

    /* The wallet surface, the `wallet` CLI's three routes (wallet/wallet.routes.ts). `status` and `history`
     * are reads; `fetch` is the one door money can leave through, and it enforces the whole consent story
     * inline: the daemon makes the request itself, parses the endpoint's x402 challenge, checks the owner's
     * policy, parks the agent's call on an approval card for anything outside the standing auto-approve
     * band, has the PLATFORM sign (the key never enters this container), retries, and answers with the paid
     * response. Same consent shape as the priced-services gate above: the model may ask, and only the
     * owner's click (or their standing delegation) moves money. */
    const walletRoutes = createWalletRoutes(services);
    app.get("/wallet/status", walletRoutes.status);
    app.post("/wallet/fetch", walletRoutes.fetch);
    app.get("/wallet/history", walletRoutes.history);

    /* The child-agent surface the `agents` CLI drives (children/children.routes.ts): start a full agent on any
     * connected provider, park until one needs input, list this conversation's children. The shell half of the
     * spawn door — the tool half mounts in-process per runtime — and the gate is the ARMING, recorded at plan
     * time where the persona was in hand (children/children.ts), because the agent token names the sandbox,
     * never a persona. Scoped to that token in auth/grants.ts like `services` and `capabilities`. */
    const childrenRoutes = createChildrenRoutes();
    app.post("/children/spawn", childrenRoutes.spawn);
    app.post("/children/wait", childrenRoutes.wait);
    app.post("/children/send", childrenRoutes.send);
    app.post("/children/answer", childrenRoutes.answer);
    app.get("/children", childrenRoutes.list);

    /* The FLEET READ surface the same CLI drives (agents/fleet.routes.ts): which conversations exist, what one
     * of them is, and which ones said a phrase — the registry, the per-conversation record, the worktree
     * composition and the phrase index joined into one answer. Its own namespace rather than a widening of
     * `/agents`, whose neighbours land, discard and archive; these two can only read, which is what lets them
     * be scoped to the agent token in auth/grants.ts beside `services` and `capabilities`. */
    const fleetRoutes = createFleetRoutes(services);
    app.get("/fleet", fleetRoutes.list);
    app.get("/fleet/:handle", fleetRoutes.show);

    // The realtime-listener control surface for an extension's gateway process (ext-discord): it reconciles via
    // /state, POSTs inbound events to /dispatch (holding an ndjson turn-stream when it wants the reply painted),
    // and reports failures/status. Reached with the per-boot panel token (the x-intentic-panel middleware branch
    // above), like every other panel-process call, registered before the oRPC catch-all.
    const listenerRoutes = createListenerRoutes(services);
    app.get("/listeners/:provider/state", listenerRoutes.state);
    app.post("/listeners/:provider/dispatch", listenerRoutes.dispatch);
    app.post("/listeners/:provider/failure", listenerRoutes.failure);
    app.post("/listeners/:provider/status", listenerRoutes.status);

    // The CI pipeline webhook receiver, public (ciWebhookPath above), secret-gated in the handler. Completed
    // pipelines freshen the runs cache and wake `ci` listener automations (see ci/webhook.routes.ts).
    app.post("/ci/webhook/:host", createCiWebhookRoute(services));

    // Desktop sync enrollment (platform/sync.routes.ts): the browser mints a pairing here, the desktop agent
    // redeems it at /system/authorized-key below. Sits before the oRPC catch-all, like /members.
    const sync = createSyncRoutes(services);
    app.post("/system/sync/pair", sync.pair);

    /* THE PEER DOORS (peers/): the user's own devices, their browsers, and this sandbox's runners, each with its
     * pairing, enrollment, roster, revoke and socket, and an MCP bridge where the agent reaches it that way. All
     * before the oRPC catch-all, like the terminal. */
    mountPeerRoutes(app, HOST_PEER, hostPeerRoutes(services));
    mountPeerRoutes(app, WEBEXT_PEER, webextPeerRoutes(services));
    mountPeerRoutes(app, RUNNER_PEER, runnerPeerRoutes(services));
    // A browser's two credential doors: a handed-over site session, and one lent back out. Authenticated by the
    // extension's own enrollment token, and deliberately not answers on the socket: see webext-protocol.ts.
    app.post("/system/webext/session", createWebExtSessionRoute(services));
    app.post("/system/webext/lend", createWebExtLendRoute(services));
    // A runner's settings push (runner.routes.ts), then its git door and its credential doors.
    app.post("/system/runners/:id/definition/sync", createRunnerDefinitionSyncRoute(services));
    // The git door runners fetch and push through (runner-git.routes.ts): stock smart HTTP off the real git
    // dirs, authenticated by the runner's own token, spawned per request. Before the oRPC catch-all.
    app.get("/system/runners/git/:repo/info/refs", createRunnerGitRefsRoute(services));
    app.post("/system/runners/git/:repo/git-upload-pack", createRunnerGitRpcRoute(services, "git-upload-pack"));
    app.post("/system/runners/git/:repo/git-receive-pack", createRunnerGitRpcRoute(services, "git-receive-pack"));
    // The credential doors (runner-credentials.routes.ts): a runner's turns spend THIS sandbox's providers —
    // per-turn access tokens, mid-turn re-mints, and the translator re-served behind the runner's own bearer.
    app.post("/system/runners/credentials", createRunnerCredentialsRoute(services));
    app.post("/system/runners/credentials/refresh", createRunnerCredentialRefreshRoute(services));
    app.all(`${runnerTranslatorPath}/*`, createRunnerTranslatorProxyRoute(services));
    // Control tokens (auth/control-tokens.routes.ts): owner-minted, durable, revocable machine credentials.
    const controlTokens = createControlTokenRoutes(services);
    app.post("/system/control/tokens", controlTokens.mint);
    app.get("/system/control/tokens", controlTokens.list);
    app.delete("/system/control/tokens/:id", controlTokens.revoke);

    // Sign out every browser, and retire browser access for good (auth/access.routes.ts; the latter is exempt
    // from the bearer middleware above so it stays repeatable after a partial attempt).
    app.post("/system/sessions/revoke", access.revokeSessions);
    app.post("/system/access/disable", access.disable);

    // Desktop sync's enrollment surface (platform/sync.routes.ts) with the merged devices view beside it
    // (hosts/devices.routes.ts). The two exact-path /system/authorized-key doors are the desktop-sync agent's
    // and exempt from the bearer middleware above; the rest ride it.
    app.post("/system/authorized-key", sync.enrollKey);
    app.get("/system/sync", sync.state);
    app.get("/system/devices", createDevicesRoute(services));
    app.post("/system/sync/report", sync.report);
    app.delete("/system/authorized-key", sync.revokeOwn);
    app.delete("/system/authorized-key/:machine", sync.revokeMachine);

    // Everything else flows through the oRPC OpenAPI handler, mounted at the root (its contract paths ARE the
    // daemon's routes). Registered last so /health + /workspace/raw match first.
    app.all("/*", async (c) => {
        const result = await orpcHandler.handle(c.req.raw, { context: buildOrpcContext(c) });
        if (result.matched) {
            return result.response;
        }
        return c.notFound();
    });

    return app;
};
