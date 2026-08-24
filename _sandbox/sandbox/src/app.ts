import { join } from "node:path";
import {
    type EnrollHostInput,
    EnrollHostInputSchema,
    type GrantedRole,
    GrantedRoleSchema,
    MachineReportSchema,
    MigrationApplySchema,
    MigrationScanSchema,
    REQUEST_ID_HEADER,
    roleAtLeast,
} from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { authorizeMaintainer, bearerFrom, ForbiddenError, tokenEquals } from "./auth/auth.js";
import { CONTROL_SCOPES } from "./auth/control-tokens.js";
import { routeFloor } from "./auth/role-floor.js";
import { grantsOf } from "./auth/grants.js";
import { streamAgent } from "./agent/agent.routes.js";
import { fireAutomation, PAYLOAD_MAX } from "./automations/scheduler.js";
import { createCapabilityAskRoutes } from "./capabilities/ask.routes.js";
import { extensionDir, extensionRead } from "./capabilities/extension-dirs.js";
import { installedExtensions } from "./extensions/installed-extensions.js";
import type { Services } from "./composition.js";
import { type AppEnv, buildOrpcContext } from "./context.js";
import { createDiffRawRoute } from "./git/diff-raw.js";
import { createSpeechRoute } from "./speech/speech.routes.js";
import { enrollHost } from "./inventory/enroll-host.js";
import { createRouter } from "./router.js";
import {
    clearAllEnrollments,
    consumePairing,
    enrollSyncKey,
    isKeyEnrolled,
    isValidAuthorizedKey,
    isValidPairing,
    machineReports,
    mintPairing,
    mirrorMachines,
    pairingMode,
    recordMachineReport,
    revokeEnrollmentByToken,
    type SyncMode,
    syncHolder,
    verifySyncToken,
} from "./platform/sync.js";
import { createSyncSshRoute } from "./platform/sync-ssh.js";
import { soleLiveConversation, turnRunOf } from "./agent/turn-runs.js";
import { relayServiceCatalog, relayServiceRun, relayServiceWant } from "./platform/pool-services.js";
import { gatedServiceRun } from "./platform/service-offer.js";
import { createWalletRoutes } from "./wallet/wallet.routes.js";
import { readEnvironmentContents } from "./environment/contents.js";
import { approveEnvironment, composeEnvironment, readEnvironment, rejectEnvironment } from "./environment/environment.js";
import { clearVersionCache } from "./environment/version-probe.js";
import { ExportBusyError, isReadyExport, listExports, openExport, removeExport, startExport } from "./portability/exports.js";
import { BundleFormatError, restoreBundle } from "./portability/restore.js";
import { MigrationFormatError } from "./migrations/archive.js";
import { createMigrations } from "./migrations/migrations.js";
import { createCiWebhookRoute } from "./ci/webhook.routes.js";
import { createListenerRoutes } from "./extensions/listener.routes.js";
import { createBrowserProfileRoute } from "./browser/browser-profile.js";
import { createHostConnectRoute, createHostMcpRoute, hostSummaries } from "./hosts/host.routes.js";
import { computers } from "./hosts/machine-reports.js";
import { createBrowserViewRoute } from "./browser/browser-view.js";
import { createTerminalRoute } from "./terminal/terminal.js";
import { createWebchatRoutes } from "./webchat/webchat.routes.js";
import { createWidgetRoute } from "./webchat/webchat-widget.js";
import { createGateRoute } from "./workflows/gate.routes.js";
import { extractTarToWorkspace, PathEscapeError } from "./workspace/workspace-archive.js";
import { computeUploadSkip, type UploadManifestEntry } from "./workspace/workspace-diff.js";
import {
    contentTypeForPath,
    isControlPlanePath,
    MAX_RAW_BYTES,
    MAX_UPLOAD_BYTES,
    openWorkspaceFileRange,
    parseByteRange,
    resolveWithin,
    sha256Text,
    UploadTooLargeError,
} from "./workspace/workspace-files.js";
import { scopedTarget } from "./workspace/workspace-scope.js";

/* Headers about ONE transport connection cannot cross the extension-backend proxy. The child host speaks
 * HTTP/1.1, whose server adds `Connection: keep-alive` and `Keep-Alive` to every answer; the browser-facing
 * loopback listener speaks HTTP/2, where Node refuses those fields and aborts the response before its body can
 * reach the browser. `Connection` may name additional hop-by-hop fields, so discover those before removing the
 * standard set. Apply the same boundary in both directions: HTTP/1 fallback clients can send them too. */
const HOP_BY_HOP_HEADERS = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;

const endToEndHeaders = (source: Headers): Headers => {
    const headers = new Headers(source);
    for (const token of headers.get("connection")?.split(",") ?? []) {
        const name = token.trim();
        if (name !== "") {
            headers.delete(name);
        }
    }
    for (const name of HOP_BY_HOP_HEADERS) {
        headers.delete(name);
    }
    return headers;
};

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

// The CI pipeline webhook receiver, its callers are github/gitlab delivery agents (no Google token), so it's
// exempt from the bearer middleware and gated by the per-sandbox webhook secret instead (github signs the
// body, gitlab echoes the token, see ci/webhook.routes.ts).
const ciWebhookPath = /^\/ci\/webhook\/[^/]+$/;

// The release gate, its callers are pipeline runners (no Google token, and no Origin either, which is why it
// cannot ride the Front Desk's allowlist), so it's exempt from the bearer middleware and gated by the workflow's
// own minted gate token instead (see workflows/gate.routes.ts).
const gatePath = /^\/workflows\/[^/]+\/gate$/;

/* The two doors a connected computer opens, both exempt from the bearer middleware because neither caller has a
 * Google identity to present:
 *
 *   /system/hosts/connect  the machine's WebSocket, it authenticates in its first frame instead of the URL
 *                          (host-protocol.ts explains why), and /system/hosts/enroll redeems its one-time pairing.
 *   /mcp/hosts/<id>        the AGENT's MCP door onto that machine, carrying the per-boot host bridge token.
 *
 * Anchored per segment so neither admits a route that merely starts the same way. */
const hostPublicPath = (path: string): boolean => path === "/system/hosts/connect" || path === "/system/hosts/enroll";
const hostMcpPath = /^\/mcp\/hosts\/[^/]+$/;

// The lowercased email in a member-management request body, or undefined when absent/malformed.
const memberEmail = async (c: Context): Promise<string | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" ? body.email.toLowerCase() : undefined;
};

// A grant request's email + role, or undefined when either is absent/malformed. The role is required, a
// grant IS a role decision, and a default picked here would be a policy nobody chose.
const memberGrant = async (c: Context): Promise<{ email: string; role: GrantedRole } | undefined> => {
    const body = (await c.req.json().catch(() => undefined)) as { email?: unknown; role?: unknown } | undefined;
    const role = GrantedRoleSchema.safeParse(body?.role);
    if (typeof body?.email !== "string" || !role.success) {
        return undefined;
    }
    return { email: body.email.toLowerCase(), role: role.data };
};

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
    // A connected computer reconnects on its own backoff, which a booting daemon would otherwise park just long
    // enough to look like an outage on the card. Its socket needs nothing the boot chain builds.
    "/system/hosts/connect",
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
                if (webchatPublicPath(c.req.path)) {
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
            // /system/authorized-key is redeemed by the desktop-sync agent with a one-time pairing token instead
            // of a bearer; the POST handler checks that token itself and the DELETE handler re-checks the owner.
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
                ciWebhookPath.test(c.req.path) ||
                gatePath.test(c.req.path) ||
                hostPublicPath(c.req.path) ||
                hostMcpPath.test(c.req.path)
            ) {
                return next();
            }
            /* The non-bearer credentials, a panel's backend, the in-container `vpn` CLI, a control token
             * (the ACP bridge, and whatever drives this sandbox from outside), the desktop-sync agent. One
             * table in auth/grants.ts says what each reaches; this loop is the only place any of them is
             * admitted. Identity stays unset for all four (documented-legal, the panel-token precedent):
             * each acts as the owner's tool rather than as a member. */
            for (const grant of grants) {
                const presented = c.req.header(grant.header);
                if (presented === undefined || presented === "") {
                    continue;
                }
                const verdict = await grant.authorize(presented, c.req.method, c.req.path);
                if (verdict === "ok") {
                    return next();
                }
                // Out of scope is its own answer on purpose: a holder of the RIGHT credential on the wrong
                // route should read "this may not go there", not a baffling missing-bearer 401.
                return verdict === "out-of-scope"
                    ? c.json({ error: `${grant.name} not valid for this route` }, 403)
                    : c.json({ error: "unauthorized" }, 401);
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
        }),
    );

    // The same bytes, for one side of a diff rather than a file in the tree, an image the review surfaces can
    // only flag as `binary` over the JSON contract. Mounted here beside /workspace/raw for the same reason it
    // is not an oRPC route: the body is a streamed binary, not JSON.
    app.route("/", createDiffRawRoute(services));

    // The composer's voice input, a WAV utterance in, its text out. A byte route for the same reason as its
    // neighbours: the JSON contract has no business carrying audio (see speech/speech.routes.ts).
    app.route("/", createSpeechRoute(services));

    /* The scoped read, in the shape these two byte routes can answer in. `scopedTarget` is the one resolver
     * (workspace/workspace-scope.ts) and it signals through ORPCError, because every other caller is an oRPC
     * handler; here the throw is translated once rather than at each of the two call sites, and an unexpected
     * error still propagates as an error rather than being flattened into a 404. */
    const scopedFileTarget = async (
        path: string,
        agent: string | undefined,
    ): Promise<{ target: string } | { error: string; status: 400 | 404 | 412 }> => {
        try {
            return { target: (await scopedTarget(services.workspaceScope, agent, path)).target };
        } catch (error) {
            if (!(error instanceof ORPCError)) {
                throw error;
            }
            if (error.code === "BAD_REQUEST") {
                return { error: error.message, status: 400 };
            }
            if (error.code === "PRECONDITION_FAILED") {
                return { error: error.message, status: 412 };
            }
            return { error: error.message, status: 404 };
        }
    };

    // Raw bytes for any file under /work, with a Content-Type by extension, the browser previews images/PDF
    // here (the text route utf8-decodes and would corrupt them). Same guards/order as workspace.file: 400 on
    // escape, 404 on missing, 413 on oversize.
    app.get("/workspace/raw", async (c) => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Whose copy, and the escape + control-plane guards with it (scopedTarget → containedIn). Shared with
        // the oRPC file route so an image in a conversation's checkout previews from the same tree its text
        // reads from; the guards throw ORPCError, which these byte routes translate to their own JSON shape.
        const scoped = await scopedFileTarget(path, c.req.query("agent"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        const target = scoped.target;
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        if (size > MAX_RAW_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        const bytes = await services.files.readBytes(target);
        if (bytes === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        // Wrap in a fresh Uint8Array so the body type is exactly Uint8Array<ArrayBuffer> (a Buffer's backing is
        // ArrayBufferLike, which Hono's body type rejects); bounded by MAX_RAW_BYTES, so the copy is cheap.
        return c.body(new Uint8Array(bytes), 200, { "Content-Type": contentTypeForPath(target), "Content-Length": String(bytes.byteLength) });
    });

    /* THE ROUTE A <video> TALKS TO ITSELF: /workspace/raw's sibling for timed media, and separate from it
     * because a media element is not a caller that wants a Blob.
     *
     * /workspace/raw answers one whole file into memory, and its 25 MiB ceiling exists precisely because it
     * does. Under that contract a recording is either refused outright or must download in full before its
     * first frame paints, and a seek to 40:00 can only wait for the 39 minutes in front of it. None of that is
     * a size problem: it is the shape of the answer. So this route answers a RANGE, streamed off disk, the
     * element asks for the header, then the index, then whatever window the user just dragged to, and each one
     * costs a seek and a 64 KiB chunk instead of the file. There is no byte cap here for the same reason: what
     * MAX_RAW_BYTES protects is the daemon's heap, and nothing is ever held.
     *
     * The credential is the other difference. Every other route on this daemon takes a bearer, and a media
     * element cannot send one, so this one takes a ticket from the query string, minted over the ordinary
     * authenticated contract (workspace.mediaTicket) and bound to a single path. See auth/media-tickets.ts for
     * why that binding is what makes a longer-lived, replayable credential an acceptable trade here.
     *
     * Loopback mode has no `auth` and therefore no ticket to check, exactly like the WebSocket upgrades. */
    app.get("/workspace/media", async (c) => {
        const path = c.req.query("path");
        if (path === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        const scoped = await scopedFileTarget(path, c.req.query("agent"));
        if ("error" in scoped) {
            return c.json({ error: scoped.error }, scoped.status);
        }
        const target = scoped.target;
        // The ticket is checked against the RESOLVED file, which is what makes the binding hold under a scope:
        // one minted for a conversation's copy of `demo.mp4` cannot be replayed for the shared tree's.
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", target)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const size = await services.files.size(target);
        if (size === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        const range = parseByteRange(c.req.header("range"), size);
        if (range === "unsatisfiable") {
            // 416 must state the real size, or the element retries the same doomed window forever.
            return c.body(null, 416, { "Content-Range": `bytes */${size}` });
        }
        const length = size === 0 ? 0 : range.end - range.start + 1;
        const headers: Record<string, string> = {
            "Content-Type": contentTypeForPath(target),
            "Content-Length": String(length),
            // Without this the element never issues a Range at all, it downloads linearly and the scrubber
            // can only reach what has already arrived.
            "Accept-Ranges": "bytes",
            // The agent rewrites files under the reader's feet; a cached window of a file that has since
            // changed is a corrupt stream, not a stale one.
            "Cache-Control": "no-store",
        };
        if (range.partial) {
            headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
        }
        /* SAVE THIS RATHER THAN PLAY IT. The browser's own `download` attribute is no use here, the daemon is
         * a different origin, where it is ignored and the link merely navigates, so the intent has to come
         * from the server. Which also makes this the download path for a file /workspace/raw would refuse:
         * nothing is buffered, so size stops mattering. RFC 5987 encoding, because a workspace filename is
         * whatever the user called it. */
        if (c.req.query("download") !== undefined) {
            headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf("/") + 1))}`;
        }
        // An empty file has no range to open, createReadStream(start: 0, end: -1) would throw.
        if (length === 0) {
            return c.body(null, 200, headers);
        }
        return c.body(openWorkspaceFileRange(target, range.start, range.end), range.partial ? 206 : 200, headers);
    });

    // Write one file under /work, the drag-drop upload AND the editor's text save both post here (bytes / utf8
    // body are the same to persist), so writes stay off oRPC like the raw read above. The body streams straight to
    // disk (no full-buffer), so multi-GB uploads stay flat in memory; parent dirs are auto-created, so a nested
    // dropped-folder path materializes its tree. Guards: 400 on escape, 413 on oversize (Content-Length first,
    // then the running byte count as it streams).
    app.post("/workspace/upload", async (c) => {
        const path = c.req.query("path");
        const target = path === undefined ? undefined : resolveWithin(services.workspace.root, path);
        if (target === undefined) {
            return c.json({ error: "invalid path" }, 400);
        }
        // Same floor as the raw read: the sandbox's private state is not writable through the generic upload,
        // or any member could hand themselves the sandbox by posting a new owner.json.
        if (isControlPlanePath(services.workspace.root, target)) {
            return c.json({ error: "not found" }, 404);
        }
        // A big file arrives as sequential parts (the browser keeps each request under Cloudflare's ~100 MB edge
        // body cap); ?offset says where this part lands, and the write goes in place instead of truncating.
        const offset = Number(c.req.query("offset") ?? 0);
        if (!Number.isInteger(offset) || offset < 0) {
            return c.json({ error: "invalid offset" }, 400);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && offset + declared > MAX_UPLOAD_BYTES) {
            return c.json({ error: "file too large" }, 413);
        }
        // The editor's guarded save: `x-intentic-base-hash` carries the sha256 of the text the browser last knew
        // on disk (its baseline), and the write is refused when the file no longer matches, an agent or terminal
        // write landed since that read, and a blind overwrite would clobber it. 409 keeps the file untouched; the
        // browser shows its changed-on-disk banner with the user's edits preserved. Drag-drop uploads send no
        // hash and overwrite as before. Check-then-write, not atomic, the guard shrinks the race window from
        // the whole edit session to this handler, which is what the agent needs (its writes echo over the SSE in
        // ~250ms; the guard covers exactly that gap).
        const baseHash = c.req.header("x-intentic-base-hash");
        if (baseHash !== undefined) {
            const current = await services.files.read(target);
            if (current === undefined || sha256Text(current) !== baseHash) {
                return c.json({ error: "the file changed on disk since it was read" }, 409);
            }
        }
        const body = c.req.raw.body;
        // An empty body (a new empty file, or saving an emptied editor buffer) has no stream to pipe. Only at
        // offset 0, an empty later part must not wipe the parts already written.
        if (body === null) {
            if (offset === 0) {
                await services.files.write(target, "");
            }
        } else {
            try {
                await services.files.writeStream(target, body, MAX_UPLOAD_BYTES, offset);
            } catch (error) {
                if (error instanceof UploadTooLargeError) {
                    return c.json({ error: "file too large" }, 413);
                }
                throw error;
            }
        }
        // A dropped file passes its source mtime as ?mtime so a re-upload can skip it (upload-diff); the editor's
        // text save sends none and keeps the write-time mtime.
        const mtime = Number(c.req.query("mtime"));
        if (Number.isFinite(mtime)) {
            await services.files.setMtime(target, mtime);
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    });

    // Re-upload diff: the client posts a manifest of what it's about to upload (path + source size + mtime) and
    // we answer which paths are already identical on disk (same size + whole-second mtime), so the browser drops
    // those and re-sends only what changed. Live-stats /work (unlike the filtered tree, this sees `.git` and has
    // no entry cap). Read-only, never writes; escaping/denied paths simply aren't reported as skippable.
    app.post("/workspace/upload-diff", async (c) => {
        const { files } = await c.req.json<{ files?: UploadManifestEntry[] }>();
        return c.json({ skip: await computeUploadSkip(services.workspace.root, files ?? []) });
    });

    // Bulk directory upload: the browser streams ONE tar of a large dropped tree here (over per-file POSTs, which
    // cost a round-trip each) and we extract it entry-by-entry into /work. Same guards as the single upload,
    // applied per entry: 400 on any escaping path (aborts), silently skips the daemon's control-plane files
    // (isControlPlanePath), 413 once the running total passes the cap. `.git` IS written, a dropped repo keeps
    // its own, so it stays connected to its remote. Streamed both ways, so a huge tree never lands in memory.
    app.post("/workspace/upload-archive", async (c) => {
        const body = c.req.raw.body;
        if (body === null) {
            return c.json({ error: "empty body" }, 400);
        }
        try {
            await extractTarToWorkspace(services.workspace.root, body, MAX_UPLOAD_BYTES);
        } catch (error) {
            if (error instanceof PathEscapeError) {
                return c.json({ error: "invalid path" }, 400);
            }
            if (error instanceof UploadTooLargeError) {
                return c.json({ error: "file too large" }, 413);
            }
            throw error;
        }
        services.history.notifyUserWrite();
        return c.json({ ok: true });
    });

    /* Mint the one-shot ticket the three WebSocket upgrades below redeem. This route is ordinary HTTP, so it
     * rides the bearer middleware like everything else, which is the entire trick: the credential is presented
     * in a header here, and what travels in the upgrade's query string is a value that is worthless the moment
     * it is used. Identity comes from the middleware, never the body.
     *
     * Loopback mode has no identity to bind a ticket to and no gate on the upgrades either, so it 404s and the
     * browser connects without one. */
    app.post("/system/ws-ticket", (c) => {
        const identity = c.get("identity");
        if (services.auth === undefined || identity === undefined) {
            return c.json({ error: "no verified identity to mint a ticket for" }, 404);
        }
        return c.json({ ticket: services.wsTickets.mint(identity) });
    });

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

    // Deploy-target enrollment from the connect-host script (curl, not a browser): authenticated by the connect
    // token alone (exempt from the bearer middleware above), so it self-registers a host without a Google login.
    // Loopback mode (no services.auth) accepts any caller, like every other route.
    app.post("/enroll", async (c) => {
        if (services.auth !== undefined && !tokenEquals(c.req.header("x-intentic-connect") ?? "", services.config.connectToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        let input: EnrollHostInput;
        try {
            input = EnrollHostInputSchema.parse(await c.req.json());
        } catch {
            return c.json({ error: "invalid enrollment body" }, 400);
        }
        try {
            await enrollHost(services, input);
        } catch (error) {
            if (error instanceof ORPCError && error.code === "PRECONDITION_FAILED") {
                return c.json({ error: error.message }, 412);
            }
            throw error;
        }
        return c.json({ ok: true });
    });

    // Webhook fire for event automations: external systems (GitHub/Sentry/monitors) POST here to wake the
    // agent, authenticated by the automation's own token as ?token=…, the only mechanism every webhook sender
    // supports. Enforced ALWAYS (fail-closed even in loopback, unlike /enroll, the token always exists). The
    // body (any format, capped) reaches the guard as AUTOMATION_PAYLOAD and is appended to the wake prompt.
    // Responds immediately; the agent turn runs detached, exactly like a scheduler fire.
    app.post("/automations/:id/fire", async (c) => {
        const automation = await services.automations.get(c.req.param("id"));
        if (automation === undefined || automation.trigger.kind !== "event") {
            return c.json({ error: "no event automation with that id" }, 404);
        }
        const token = automation.trigger.token;
        if (token === undefined || !tokenEquals(c.req.query("token") ?? "", token)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        if (!automation.enabled) {
            return c.json({ error: "automation disabled" }, 409);
        }
        const declared = Number(c.req.header("content-length"));
        if (Number.isFinite(declared) && declared > PAYLOAD_MAX) {
            return c.json({ error: "payload too large" }, 413);
        }
        const payload = await c.req.text();
        // A webhook is an outside message too, so its wake opens a surfaced conversation like a Discord mention's
        // does, the sender is a system, not a person, so the origin carries no author or channel.
        void fireAutomation(services, automation, streamAgent, {
            ...(payload === "" ? {} : { payload }),
            origin: { automationId: automation.id, provider: "webhook" },
            title: `Webhook: ${automation.id}`,
        }).catch((error: unknown) => services.logger.error({ err: error, automation: automation.id }, "automation run failed"));
        return c.json({ ok: true });
    });

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

    // The operating gate used by privileged sandbox controls. Maintainer is deliberately owner-equivalent here;
    // ownership itself is kept separate below for the one thing a revokable grant cannot control: membership.
    const ownerDenied = async (c: Context): Promise<Response | undefined> => {
        if (services.auth === undefined) {
            return undefined;
        }
        try {
            await authorizeMaintainer(services.auth, bearerFrom(c.req.header("authorization")));
            return undefined;
        } catch (error) {
            return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
        }
    };
    const ownershipDenied = async (c: Context): Promise<Response | undefined> => {
        if (services.auth === undefined) {
            return undefined;
        }
        try {
            await services.auth.authorizeOwner(bearerFrom(c.req.header("authorization")));
            return undefined;
        } catch (error) {
            return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
        }
    };
    const canOperate = async (c: Context): Promise<boolean> => (await ownerDenied(c)) === undefined;
    app.get("/members", async (c) => {
        const denied = await ownershipDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ members: await services.members.list() });
    });
    app.post("/members", async (c) => {
        const denied = await ownershipDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const grant = await memberGrant(c);
        if (grant === undefined) {
            return c.json({ error: "email and role required" }, 400);
        }
        await services.members.add(grant.email, grant.role);
        // A role is frozen into an already-open socket/ticket. Close both so the next transport re-enters the
        // authorizer and picks up the new tier (especially a downgrade).
        services.auth?.connections.revoke(grant.email);
        services.wsTickets.revoke(grant.email);
        return c.json({ members: await services.members.list() });
    });
    app.delete("/members", async (c) => {
        const denied = await ownershipDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const email = await memberEmail(c);
        if (email === undefined) {
            return c.json({ error: "email required" }, 400);
        }
        await services.members.remove(email);
        services.auth?.connections.revoke(email);
        services.wsTickets.revoke(email);
        return c.json({ members: await services.members.list() });
    });
    app.delete("/members/self", async (c) => {
        const identity = c.get("identity");
        if (identity === undefined) {
            return c.json({ error: "verified member required" }, 401);
        }
        if (identity.role === "owner") {
            return c.json({ error: "the owner must retire the sandbox instead" }, 400);
        }
        await services.members.remove(identity.email);
        services.auth?.connections.revoke(identity.email);
        services.wsTickets.revoke(identity.email);
        return c.json({ ok: true });
    });

    // The agent-proposed overlay Dockerfile (.intentic/config/environment.Dockerfile). Members see the state; only the
    // owner approves (copying it to the approved file) or rejects (deleting the proposal). The rebuild itself
    // runs OUTSIDE the container, recreate.sh locally, the workspace provider on a server, pinned to the
    // approved hash, so approval here never mutates the running sandbox.
    app.get("/environment", async (c) => c.json(await readEnvironment(services)));
    /* The same sandbox read as CONTENTS rather than as a recipe, what it has, with each tool's version read back
     * from the tool. A route of its own because it costs process spawns: /environment above is polled by the
     * shell's rebuild banner and re-fetched on every write under .intentic/environment., and making that pay for
     * forty version checks would be a tax on the whole app for one tab. `refresh` re-probes, which is what the
     * card's refresh button is for, a tool installed mid-session is otherwise cached as missing. */
    app.get("/environment/contents", async (c) => {
        if (c.req.query("refresh") !== undefined) {
            clearVersionCache();
        }
        return c.json(await readEnvironmentContents(services));
    });
    app.post("/environment/approve", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { hash?: unknown } | undefined;
        const hash = typeof body?.hash === "string" ? body.hash : undefined;
        if (hash === undefined) {
            return c.json({ error: "hash required" }, 400);
        }
        const failure = await approveEnvironment(services, hash);
        if (failure === "missing") {
            return c.json({ error: "no proposal to approve" }, 404);
        }
        if (failure === "mismatch") {
            return c.json({ error: "the proposal changed since it was reviewed, refresh and re-approve" }, 409);
        }
        if (failure === "invalid") {
            return c.json(
                { error: "the proposal must contain only RUN/ENV content, no FROM (the daemon owns the base image) and no intentic:runtime lines" },
                400,
            );
        }
        return c.json(await readEnvironment(services));
    });
    app.post("/environment/reject", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        await rejectEnvironment(services);
        return c.json(await readEnvironment(services));
    });

    /* The environment BUNDLE: this sandbox's two volumes packed for a move, and the restore that unpacks one.
     *
     * Raw Hono rather than oRPC for the same reason the upload routes are, a restore and a download are streams
     * of arbitrary size, and neither end may hold one. Owner-only throughout and not merely by convention: an
     * export reads every repo and (at the owner's choice) every credential the sandbox holds, and a restore
     * overwrites the workspace a fleet may be working in.
     *
     * The EXPORT is an artifact, not a response. `POST /bundles` starts the pack and answers with its name at
     * once; the bytes land in the daemon's export directory and `GET /bundles` reads that directory back. This
     * is what makes an export survive the tab that asked for it, see portability/exports.ts for why the first
     * cut, which streamed the pack down the click's own response, could not.
     */
    app.get("/bundles", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ exports: await listExports(services.config.historyRoot) });
    });

    // Start one. `?secrets=1` is the owner's choice and it changes the BYTES, not the framing, the bundle
    // records what it was made with, and the restore report explains what the choice cost. Default off: the
    // safe bundle is the one you can hand to somebody else.
    app.post("/bundles", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        try {
            return c.json({ name: await startExport(services, { secrets: c.req.query("secrets") === "1", now: Date.now() }) });
        } catch (error) {
            if (error instanceof ExportBusyError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
    });

    app.delete("/bundles", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const removed = await removeExport(services.config.historyRoot, c.req.query("name") ?? "");
        return removed ? c.json({ ok: true }) : c.json({ error: "no such export" }, 404);
    });

    /* Mint a ticket for ONE bundle, then serve it at the route below.
     *
     * A download has the same problem a <video> has (see /workspace/media): the browser must fetch it ITSELF for
     * the bytes to stream to disk rather than through the tab's memory, and a navigation cannot carry an
     * Authorization header. The containment is the same too, the ticket names one bundle and buys nothing else.
     * Namespaced `bundle:` so a ticket minted here can never be replayed against a workspace path, nor a media
     * ticket against a bundle.
     */
    app.post("/bundles/ticket", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const name = c.req.query("name") ?? "";
        if (!(await isReadyExport(services.config.historyRoot, name))) {
            return c.json({ error: "no such export" }, 404);
        }
        return c.json(services.mediaTickets.mint(`bundle:${name}`));
    });

    app.get("/bundles/download", async (c) => {
        const name = c.req.query("name") ?? "";
        if (services.auth !== undefined && !services.mediaTickets.valid(c.req.query("ticket") ?? "", `bundle:${name}`)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        // Resolved through the export LIST, so only a finished bundle this daemon produced can be named here,
        // a query string can never walk it onto another file.
        const opened = await openExport(services.config.historyRoot, name);
        if (opened === undefined) {
            return c.json({ error: "no such export" }, 404);
        }
        return c.body(opened.body, 200, {
            "Content-Type": "application/gzip",
            // A real length, unlike the streamed-as-you-pack first cut: the browser can show a progress bar and
            // resume, because the file already exists in full before anyone asks for it.
            "Content-Length": String(opened.size),
            "Content-Disposition": `attachment; filename="${name}"`,
            "Cache-Control": "no-store",
        });
    });

    app.post("/bundles/restore", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = c.req.raw.body;
        if (body === null) {
            return c.json({ error: "empty body" }, 400);
        }
        try {
            const report = await restoreBundle(
                body,
                { workspaceRoot: services.workspace.root, historyRoot: services.config.historyRoot },
                MAX_UPLOAD_BYTES,
            );
            // The restore wrote manifests the daemon's own state is derived from (capabilities, the custom
            // overlay section), so recompose before answering, the Environment card then renders the target's
            // own composition, against ITS base image, instead of whatever the source last had.
            await composeEnvironment(services);
            services.history.notifyUserWrite();
            return c.json(report);
        } catch (error) {
            if (error instanceof BundleFormatError) {
                return c.json({ error: error.message }, 400);
            }
            if (error instanceof UploadTooLargeError) {
                return c.json({ error: "bundle too large" }, 413);
            }
            throw error;
        }
    });

    /* MIGRATIONS: importing a FOREIGN assistant's setup (a packed `~/.hermes`), preview-first. Raw Hono beside
     * the bundle routes for the same reason they are, the plan's input is an upload stream, and owner-only
     * throughout: the archive is somebody's credential store and the apply writes settings, skills, automations
     * and capabilities. Two calls: `plan` parses the upload into a checklist and holds it in memory under a
     * token; `apply` names the ticked ids. See migrations/migrations.ts for why nothing is held on disk. */
    const migrations = createMigrations(services);
    app.post("/migrations/plan", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = c.req.raw.body;
        if (body === null) {
            return c.json({ error: "empty body" }, 400);
        }
        try {
            return c.json(await migrations.plan(body, MAX_UPLOAD_BYTES));
        } catch (error) {
            if (error instanceof MigrationFormatError) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });
    /* The owner's own computers as import sources, probed live, because the whole value is that the offer
     * appears BEFORE they read a packing instruction. Never fails the card: a machine that is asleep or holds
     * nothing is a row saying so, which is why every probe is caught into its own `detail`. */
    app.get("/migrations/hosts", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ hosts: await migrations.hosts() });
    });
    app.post("/migrations/scan", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const parsed = MigrationScanSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "expected { host }" }, 400);
        }
        try {
            return c.json(await migrations.scan(parsed.data.host));
        } catch (error) {
            if (error instanceof MigrationFormatError) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });
    app.post("/migrations/apply", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const parsed = MigrationApplySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "expected { token, items, includeSecrets }" }, 400);
        }
        try {
            return c.json(await migrations.apply(parsed.data));
        } catch (error) {
            // A stale/consumed token is the caller's staleness, not breakage: 409 so the UI re-uploads.
            if (error instanceof MigrationFormatError) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
    });
    app.delete("/migrations", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ ok: migrations.abandon() });
    });

    // An extension's prebuilt ESM bundle, raw JS bytes, so a plain Hono route like /environment (oRPC is for
    // JSON). The web loader fetches this with auth → Blob URL → import(). The ETag is the code identity: the
    // pinned HEAD sha for a git-installed extension (sha-pinned installs make the bundle immutable per commit),
    // and the content hash for a workspace one, whose dir is live-edited and has no commit to stand for it.
    app.get("/extensions/:id/bundle", async (c) => {
        const id = c.req.param("id");
        const extension = (await installedExtensions(services)).find((entry) => entry.id === id);
        if (extension === undefined) {
            return c.json({ error: "no extension with that id" }, 404);
        }
        if (extension.manifest.entry === undefined) {
            return c.json({ error: "the extension has no UI entry" }, 404);
        }
        const source = await extensionRead(join(extension.dir, extension.manifest.entry));
        if (source === undefined) {
            return c.json({ error: "the entry bundle is missing from the extension" }, 404);
        }
        const etag = extension.source === "installed" ? await services.git.head(extensionDir(services.workspace.root, id)) : sha256Text(source);
        if (c.req.header("if-none-match") === etag) {
            return c.body(null, 304);
        }
        return c.body(source, 200, { "content-type": "text/javascript; charset=utf-8", etag });
    });

    /* Extension backend namespaces: /x/<id>/* proxied verbatim to the backend host (extensions/backend/).
     * The request has already been through everything above: the boot gate, CORS, and the bearer middleware
     * with its role floor (an unlisted GET floors at viewer, an unlisted mutation at maintainer, the same
     * defaults every unclassified core route gets). What is forwarded is the request MINUS its credentials:
     * the backend acts on the daemon through its own scoped token, and handing it the owner's bearer would
     * quietly re-grant everything the token model just took away. A host mid-restart answers 503 with the
     * supervisor's own words, which is the web's cue to retry rather than to render an error state. */
    app.all("/x/*", async (c) => {
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            const backend = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${backend.state}${backend.detail !== undefined ? `, ${backend.detail}` : ""}` }, 503);
        }
        const url = new URL(c.req.url);
        const headers = endToEndHeaders(c.req.raw.headers);
        headers.delete("authorization");
        headers.set("x-intentic-backend", target.hostToken);
        const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body;
        const upstream = await fetch(`http://127.0.0.1:${target.port}${url.pathname}${url.search}`, {
            method: c.req.method,
            headers,
            ...(body !== undefined && body !== null ? { body, duplex: "half" } : {}),
        } as RequestInit);
        return new Response(upstream.body, { status: upstream.status, headers: endToEndHeaders(upstream.headers) });
    });

    /* The creator pool's metered services, relayed to the platform (platform/pool-services.ts), the catalog
     * with the owner's credit meter, and one priced run. The daemon contributes the connect token; the
     * platform holds the member gate, the meter and the refund discipline, and its refusals are already
     * written for the reader. These are the routes an extension backend declares in `permissions.daemon` to
     * spend the owner's credits, a mutation, so the bearer middleware floors the run at maintainer for
     * browsers, like every unlisted POST.
     *
     * WHO GETS GATED: the AGENT's own run call, the request that presented the agent token, which commits it
     * to that grant (grants.ts), parks on an owner-approval card before anything is spent
     * (platform/service-offer.ts). An extension backend passes straight through: which services it may run is
     * declared in its manifest and was approved at install. A browser session is the owner acting directly. */
    app.get("/pool/services", async (c) => {
        const answer = await relayServiceCatalog(services.config);
        return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
    });
    // The wanted list: an agent that read the catalog and found nothing that answers files what it looked
    // for. No spend, no card, the platform bounds it (length, a daily cap per owner) and publishes only the
    // aggregate, so this relays as plainly as the catalog read above.
    app.post("/pool/wanted", async (c) => {
        const answer = await relayServiceWant(services.config, await c.req.text());
        return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
    });
    app.post("/pool/services/:slug/run", async (c) => {
        const viaAgent = (c.req.header("x-intentic-agent") ?? "") !== "";
        const answer = viaAgent
            ? await gatedServiceRun(
                  {
                      catalog: () => relayServiceCatalog(services.config),
                      run: (slug, body, onStatus) => relayServiceRun(services.config, slug, body, onStatus),
                      liveRun: (conversationId) => {
                          const id = conversationId ?? soleLiveConversation();
                          const run = id === undefined ? undefined : turnRunOf(id);
                          return id === undefined || run === undefined || run.done
                              ? undefined
                              : { conversationId: id, push: (event) => run.push(event) };
                      },
                      observe: (conversationId, event) => services.agents.observe(conversationId, event),
                  },
                  {
                      slug: c.req.param("slug"),
                      body: await c.req.text(),
                      conversationId: c.req.header("x-intentic-conversation"),
                      why: c.req.query("why"),
                      signal: c.req.raw.signal,
                  },
              )
            : await relayServiceRun(services.config, c.req.param("slug"), await c.req.text());
        return c.newResponse(answer.body, answer.status as 200, {
            "content-type": answer.contentType,
            // The platform's advisory meter header rides through, so every caller's receipt line works.
            ...(answer.remaining !== undefined ? { "x-intentic-credits-remaining": answer.remaining } : {}),
        });
    });

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

    // Desktop enrollment (Mutagen). The browser mints a short-lived pairing token; the desktop agent redeems it
    // once at /system/authorized-key to land its SSH key, so the agent needs no OAuth, and trust roots in the
    // Google identity that minted the token. The pairing carries the MODE it may enroll: the owner gets full
    // file "sync" (default, or "mirror" on request), a member (collaborator) can only get port "mirror", so
    // live previews are everyone's while the single-holder file-sync lock stays owner-territory. The route runs
    // through the bearer middleware (not exempt), so an unauthenticated caller is already 401'd here. Sits before
    // the oRPC catch-all, like /members and /workspace/raw.
    app.post("/system/sync/pair", async (c) => {
        const requested = c.req.query("mode") === "mirror" ? "mirror" : "sync";
        const mode: SyncMode = (await canOperate(c)) ? requested : "mirror";
        return c.json({ ...mintPairing(mode), mode });
    });

    /* The user's own computers (hosts/). Same trust root as desktop sync, the owner mints a single-use pairing
     * in the browser and the connect one-liner carries it, narrowed in one way that matters: a pairing is bound
     * to ONE host capability, so a redeemed token can only ever become the machine the owner was looking at when
     * they clicked Connect. Owner-only to mint: giving a member hands on the owner's laptop is not a collaboration
     * feature. */
    app.post("/system/hosts/pair", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.query("id") ?? "";
        const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === "host");
        if (capability === undefined) {
            return c.json({ error: "no connected-computer capability with that id" }, 404);
        }
        return c.json(services.hosts.mintPairing(id));
    });
    // Redeemed by the machine's installer, authorized by the pairing alone (exempt from the bearer middleware),
    // so nobody signs into Google on the machine being connected.
    app.post("/system/hosts/enroll", async (c) => {
        const enrolled = await services.hosts.enroll(c.req.header("x-intentic-pair") ?? "");
        if (enrolled === undefined) {
            return c.json({ error: "pairing expired, click Connect again in your browser for a fresh command." }, 401);
        }
        return c.json(enrolled);
    });
    app.get("/system/hosts", async (c) => c.json({ hosts: await hostSummaries(services) }));
    // Revoke: the enrollment goes, and the live socket with it. The agent binary on that machine notices its
    // reconnect being refused and stops; what stays is the installation, which only the machine's owner can remove.
    app.delete("/system/hosts/:id", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const id = c.req.param("id") ?? "";
        services.hostHub.disconnect(id, "this computer's access was revoked");
        return (await services.hosts.revoke(id)) ? c.json({ ok: true }) : c.json({ error: "no such computer" }, 404);
    });
    // The machine's own socket, and the agent's door onto it. Both before the oRPC catch-all, like the terminal.
    app.get("/system/hosts/connect", createHostConnectRoute(services));
    const hostMcp = createHostMcpRoute(services);
    app.post("/mcp/hosts/:id", hostMcp);
    app.get("/mcp/hosts/:id", hostMcp);
    app.delete("/mcp/hosts/:id", hostMcp);
    /* Control tokens, owner-minted (the sync-pair trust model, made durable + revocable), raw value returned
     * exactly once. What each scope reaches is auth/control-tokens.ts. Plain routes before the oRPC catch-all,
     * like the pair block.
     *
     * The scope is REQUIRED rather than defaulted: every default here is wrong for somebody, and a mint that
     * quietly picks the narrowest one produces a token that 403s on the caller's first real call, while a
     * mint that picks a generous one hands out more reach than was asked for. Making the caller say it is one
     * extra field and no ambiguity. */
    app.post("/system/control/tokens", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        const body = (await c.req.json().catch(() => undefined)) as { label?: unknown; scope?: unknown } | undefined;
        const scope = CONTROL_SCOPES.find((candidate) => candidate === body?.scope);
        if (scope === undefined) {
            return c.json({ error: `scope must be one of: ${CONTROL_SCOPES.join(", ")}` }, 400);
        }
        const label = typeof body?.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 60) : scope;
        return c.json(await services.controlTokens.mint(label, scope));
    });
    app.get("/system/control/tokens", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return c.json({ tokens: await services.controlTokens.list() });
    });
    app.delete("/system/control/tokens/:id", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        return (await services.controlTokens.revoke(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "no such token" }, 404);
    });
    /* Sign out every browser: re-key the session signer, so all sessions minted for this sandbox stop
     * verifying at once (auth/session.ts). Owner-only, and the owner's OWN browser is included, it 401s on its
     * next call and silently re-establishes from the Google credential it already holds, which is what makes
     * this safe to offer as a button rather than a support procedure.
     *
     * Here rather than on the members routes because it is not about who may access the sandbox, it is about
     * what is still holding a credential to it, which is the question a lost laptop actually asks. Loopback
     * mode has no sessions to rotate and no owner to check, so it answers ok without doing anything. */
    app.post("/system/sessions/revoke", async (c) => {
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        await services.auth?.rotateSessions();
        services.auth?.connections.revoke();
        services.wsTickets.revoke();
        return c.json({ ok: true });
    });
    // Account deletion, stronger than sign-out-everywhere: permanently refuse future browser authorization
    // before rotating sessions and closing every live transport. A surviving Google proof/connect token can no
    // longer re-establish. Local/control credentials remain available for machine-owner cleanup.
    app.post("/system/access/disable", async (c) => {
        if (services.auth !== undefined) {
            try {
                await services.auth.authorizeRetirement(bearerFrom(c.req.header("authorization")));
            } catch (error) {
                return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
            }
        }
        await services.auth?.disableBrowserAccess();
        await services.auth?.rotateSessions();
        services.auth?.connections.revoke();
        services.wsTickets.revoke();
        return c.json({ ok: true });
    });
    app.post("/system/authorized-key", async (c) => {
        // Authorized either by a valid pairing token (the agent's path) or the owner's Google token (fallback).
        const pair = c.req.header("x-intentic-pair") ?? undefined;
        const viaPair = pair !== undefined && isValidPairing(pair);
        if (!viaPair) {
            const denied = await ownerDenied(c);
            if (denied !== undefined) {
                return denied;
            }
        }
        const body = (await c.req.json().catch(() => undefined)) as { key?: unknown } | undefined;
        const key = typeof body?.key === "string" ? body.key : undefined;
        if (key === undefined || !isValidAuthorizedKey(key)) {
            return c.json({ error: "invalid key" }, 400);
        }
        // The mode comes from the pairing (minted per the requester's role), never from the agent, so a member's
        // pairing can only ever enroll "mirror". The owner-Google fallback path defaults to full "sync".
        const mode: SyncMode = viaPair ? (pairingMode(pair) ?? "mirror") : "sync";
        // A "sync" enroll is single-holder: if a different machine holds it and this isn't a takeover, 423 Locked
        // (before consuming the token, so a retry with --takeover reuses the same pairing). Mirror enrolls never lock.
        const takeover = c.req.header("x-intentic-sync-takeover") === "1";
        const result = await enrollSyncKey({ historyRoot: services.config.historyRoot, key, mode, takeover });
        if ("locked" in result) {
            return c.json({ error: "sync already active", machine: result.locked }, 423);
        }
        // Burn the pairing token only on success, so a transient failure leaves it usable for a retry.
        if (pair !== undefined) {
            await consumePairing(services.config.historyRoot, pair);
        }
        /* No address travels back any more, because there is no longer one to choose: the agent reaches sshd
         * through THIS daemon (platform/sync-ssh.ts), at the public URL it is already talking to. That is what
         * makes every sandbox sync the same way, the enroll used to answer 409 whenever the sandbox's
         * reachability could not also carry TCP, which is every sandbox on the platform's own hub. */
        return c.json({ ok: true, syncToken: result.syncToken, mode });
    });
    app.get("/system/sync", async (c) => {
        // Any collaborator (owner or member) may read enrollment state, the bearer middleware already blocked a
        // non-member, so a member's Desktop-sync card can render and mint its mirror-only pairing.
        const holder = await syncHolder(services.config.historyRoot);
        const mirrors = await mirrorMachines(services.config.historyRoot);
        // Always 200, and `available` is now always true: sync rides this daemon's own HTTPS surface, so every
        // sandbox that can serve this response can also carry the transport (platform/sync-ssh.ts). It stays in
        // the body because the card branches on it, and because a sandbox that CANNOT do sync is a state worth
        // being able to express again rather than one to delete the vocabulary for. syncingFrom names the single
        // machine holding file sync (takeover target) and when it was last heard from, an enrollment nobody has
        // used for hours is a sync that has stopped, which the card must not report as healthy. mirroredBy lists
        // every machine mirroring ports (unlimited, each collaborator on their own localhost).
        // `machines` is what each enrolled computer says about ITSELF (folders, ports, watcher), the half the
        // enrollment record above has never been able to answer. Empty until a machine's watcher posts one, which
        // is also what an old agent looks like, so the card must render without it.
        return c.json({
            enrolled: await isKeyEnrolled(services.config.historyRoot),
            ...(holder !== undefined ? { syncingFrom: holder.machine, ...(holder.seenAt === undefined ? {} : { syncSeenAt: holder.seenAt }) } : {}),
            ...(mirrors.length > 0 ? { mirroredBy: mirrors } : {}),
            available: true,
            machines: (await machineReports(services.config.historyRoot)).map((entry) => entry.report),
        });
    });
    /* Every computer on the other end of this sandbox, the volunteered reports and the ones pulled through a
     * host capability, merged (hosts/machine-reports.ts). Readable by any collaborator, like /system/sync beside
     * it: the bearer middleware already blocked a non-member, and a member's own mirroring machine appears here. */
    app.get("/system/computers", async (c) => c.json({ computers: await computers(services) }));
    // Acting on one of those computers' sandboxes is `system.manageMachineSandbox` (system.routes.ts) rather than
    // a plain route here: every op streams, because the slowest of them takes minutes, and a hand-rolled SSE
    // response beside the oRPC surface would be a second shape for the browser to parse.
    /* The machine's own report, filed on the same credential its ports poll uses (grants.ts scopes the sync token
     * to exactly this route and that read). The agent posts on its watch tick, so the sandbox learns the folder,
     * the ports and the watcher's liveness without ever asking for anything new from the computer. */
    app.post("/system/sync/report", async (c) => {
        const sync = c.req.header("x-intentic-sync") ?? "";
        const parsed = MachineReportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: "malformed report" }, 400);
        }
        return (await recordMachineReport(services.config.historyRoot, sync, parsed.data))
            ? c.json({ ok: true })
            : c.json({ error: "unknown enrollment" }, 403);
    });
    app.delete("/system/authorized-key", async (c) => {
        // Two revoke paths: an agent uninstalling self-revokes with its own sync token (removes just its
        // enrollment); the owner (Google) clears EVERY enrollment, the "Disable desktop sync" kill switch.
        const sync = c.req.header("x-intentic-sync") ?? undefined;
        if (sync !== undefined && sync !== "") {
            return (await revokeEnrollmentByToken(services.config.historyRoot, sync))
                ? c.json({ ok: true })
                : c.json({ error: "unknown enrollment" }, 404);
        }
        const denied = await ownerDenied(c);
        if (denied !== undefined) {
            return denied;
        }
        await clearAllEnrollments(services.config.historyRoot);
        return c.json({ ok: true });
    });

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
