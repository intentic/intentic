import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { CONNECT_TOKEN_HEADER, REQUEST_ID_HEADER } from "@intentic/sandbox-contract/protocol/headers";
import type { RouteMeta } from "@intentic/sandbox-contract/protocol/route-meta";
import { sandboxRouteFor } from "@intentic/sandbox-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { withGitCaller } from "@intentic/base/git";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { compressResponses } from "./http/compress-responses.js";
import { watchResponseLength } from "./http/response-length.js";
import { bearerFrom, ForbiddenError, OwnerUnreadableError, PasskeyRequiredError, PlatformKeyUnknownError } from "./auth/auth.js";
import { allowedOriginsOf, desktopBundleOnLoopback, originAllowedBy } from "./auth/browser-origins.js";
import { LISTENER_HEADER, listenerOf } from "./auth/proofs/listener.js";
import { memberRefusal } from "./auth/role-floor.js";
import { orgLocks } from "./org/org-locks.middleware.js";
import { admitByGrant, grantsOf } from "./auth/grants.js";
import type { Services } from "./composition.js";
import { type AppEnv, buildOrpcContext } from "./app-env.js";
import { auditRequests } from "./audit/audit-http.js";
import { createRouter } from "./router.js";
import { verifySyncToken } from "./peers/desktop-sync.js";
import { logContext } from "./logger.js";
import { appRawRoutes } from "./app-raw-routes.js";
import { serveRawRoutes } from "./http/raw-route-server.js";

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

// The label a request's git runs are counted under: the contract route it matched, never the raw path, whose ids would
// split one route into thousands of callers.
export const gitCallerOfRequest = (method: string, path: string): string => `http ${sandboxRouteFor(method, path)?.name ?? "unrouted"}`;

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

    // Inside the hardening, outside everything that writes an answer, so every JSON body leaves compressed when the
    // browser accepts it, error bodies included.
    app.use("*", compressResponses());

    // Outermost: times the answer the browser actually waited for, the only number that also covers the boot gate, auth
    // and oRPC validation.
    // Streams are exempt since they're long-lived by design; timing them would log every healthy connection as the
    // slowest request.
    // Also where a request gets its id: the browser's own when it sent one, so a report matches a log line by id, and
    // one made here otherwise (the CLI, an extension, curl), so every line of one request still shares a key. Either
    // way it is echoed on the answer, which is how a caller that sent none learns what to grep for.
    app.use("*", async (c, next) => {
        const path = c.req.path;
        // Every answer, streams included: a body shorter than its declared length hangs the browser behind a 200.
        // SAFETY: the daemon is served by @hono/node-server (netd-door.ts), whose binding this is; absent under `app.request`.
        const outgoing = (c.env as Partial<HttpBindings> | undefined)?.outgoing;
        watchResponseLength(outgoing, c.req.method, (mismatch) =>
            services.logger.warn({ method: c.req.method, path, ...mismatch }, "http: an answer's body did not match the length it declared"),
        );
        if (policyOf(c).stream === true) {
            return next();
        }
        const from = process.hrtime.bigint();
        const requestId = c.req.header(REQUEST_ID_HEADER) ?? randomUUID();
        // Git the request runs is counted under its route (gitRunCallers); a span inside it names a narrower caller.
        await logContext.run({ requestId }, () => withGitCaller(gitCallerOfRequest(c.req.method, path), next));
        c.header(REQUEST_ID_HEADER, requestId);
        // A turn's MCP call (`/mcp/<mount>`, agent/tools/turn-mounts.routes.ts) lasts as long as the tool it runs: a
        // device's command, a browser's page load, seconds to minutes by design. Under http.request those topped every
        // ranking and buried the reads a person waits on, so they are their own op with their own budget.
        const mount = /^\/mcp\/([^/]+)/u.exec(path)?.[1];
        services.perf.record(mount === undefined ? "http.request" : "mcp.call", Number(process.hrtime.bigint() - from) / 1e6, {
            method: c.req.method,
            path,
            status: c.res.status,
            requestId,
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

    // The audit trail's request side (audit/audit-http.ts): above authentication, so a refused change is recorded beside
    // an accepted one, and inside the boot gate, so nothing is recorded against half-built state.
    app.use("*", auditRequests(services.audit));

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
                // header. The desktop app's own bundled page is a match on the loopback port alone (browser-origins.ts).
                return originAllowed(origin) || desktopBundleOnLoopback(origin, c.req.header(LISTENER_HEADER)) ? origin : null;
            },
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            // REQUEST_ID_HEADER must be allow-listed too, or the preflight drops it and the correlation stays empty.
            // content-encoding: an upload the browser gzipped (http/request-body.ts).
            allowHeaders: ["authorization", "content-type", "content-encoding", CONNECT_TOKEN_HEADER, "x-intentic-base-hash", REQUEST_ID_HEADER],
            // Chrome's own ceiling. Every call carries `authorization`, so each distinct URL (and a route's inputs are in
            // its URL) is asked about once before it is sent, and a phone on a cellular link pays that round trip again
            // for every URL whose answer has expired: ten minutes made most of a working session's reads two trips.
            maxAge: 7200,
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
                const caller = await authorize(bearerFrom(c.req.header("authorization")), c.req.header(CONNECT_TOKEN_HEADER) ?? undefined, {
                    enrolment: policy.enrolment === true,
                    // A session the machine minted stands on its loopback port alone (auth/proofs/proof-methods.ts).
                    listener: listenerOf((name) => c.req.header(name)),
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
                // 403 is a verified identity that isn't the owner/member, with a machine-readable reason where the editor
                // acts on one (an email sign-in the owner has not allowed); 401 reads like any other unreachable daemon.
                if (error instanceof ForbiddenError) {
                    return c.json({ error: error.message, reason: error.reason }, 403);
                }
                // 428: the identity is welcome, the proof is not enough; the body says whether a passkey is held or
                // must first be added (the contract's PasskeyRequired).
                if (error instanceof PasskeyRequiredError) {
                    return c.json({ error: error.message, requires: "passkey", enrolled: error.enrolled }, 428);
                }
                // Still a 401, fail-closed, naming only why: no sign-in can succeed until the host moves the owner file
                // aside, which the auth slice logged with the command that does it; or the daemon has not learned the
                // platform's identity key yet, so the editor retries rather than asking for another sign-in.
                if (error instanceof OwnerUnreadableError || error instanceof PlatformKeyUnknownError) {
                    return c.json({ error: "unauthorized", reason: error.reason }, 401);
                }
                return c.json({ error: "unauthorized" }, 401);
            }
            return next();
        });
    }

    // An organisation's locks, for every credential alike, the owner's included (org/org-locks.middleware.ts).
    app.use("*", orgLocks(services.orgPolicy));

    // Every raw route, each under its declaration and in RAW_ROUTES order, so none exists without a policy and the
    // contract alone decides which of two overlapping routes answers (raw-routes.ts); app-raw-routes.ts is every table.
    serveRawRoutes(app, appRawRoutes(services));

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
