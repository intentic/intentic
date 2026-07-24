import { randomBytes, randomUUID } from "node:crypto";
import { API_BASE_PATH } from "@intentic-app/api-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { type Auth, createAuth } from "./auth.js";
import { CloudflareTokenError, ensurePreviewRoutes, provisionHostSshTunnel } from "./sandbox/cloudflare.js";
import type { Config } from "./config.js";
import { buildOrpcContext, type OrpcContext } from "./context.js";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { decryptSecret } from "./crypto.js";
import type { Logger } from "pino";
import { router } from "./router.js";
import { createTracingHttpMiddleware } from "./tracing.js";
import type { PrismaClient } from "@intentic-app/prisma";

type AppEnv = { Variables: { logger: Logger } };

// Accept only a valid https origin so a bogus value can't be stored as the sandbox's address.
const isHttpsUrl = (value: string): boolean => {
    try {
        return new URL(value).protocol === `https:`;
    } catch {
        return false;
    }
};

// A mintable preview-route label. Only the two preview schemes are allowed (an arbitrary label could shadow
// sandbox-/ssh- hostnames); ≤50 chars keeps the full first label `<label>-<12-hex id>` inside DNS's 63-char
// label limit.
const validPreviewLabel = (label: unknown): boolean =>
    typeof label === `string` && /^(preview|port)-[a-z0-9][a-z0-9-]*$/.test(label) && label.length <= 50;

const logUnexpectedError = (log: Logger, error: unknown): void => {
    // oRPC "expected" errors (UNAUTHORIZED, NOT_FOUND, …) are control flow, not incidents — don't log them.
    if (error instanceof ORPCError && error.code !== `INTERNAL_SERVER_ERROR`) {
        return;
    }
    log.error({ err: error }, `unexpected error`);
};

// The platform is the sandbox REGISTRY: each daemon announces its own URL + liveness here (outbound-only,
// authenticated by its connect token), and the browser reads the registry, then talks to the daemon DIRECTLY
// over its tunnel for everything else. No relay, no platform→sandbox calls — a breach still can't reach into
// any sandbox. The public (sessionless) routes are /setup/claim (the connect script redeems its setup code)
// and the connect-token-authenticated daemon relays /sandbox/announce (phone-home), /sandbox/host-tunnel and
// /sandbox/preview-route (minted on intentic's own Cloudflare). sandbox.zones is the one route handed an infra secret (the
// Cloudflare token), and only transiently — it lists zones for the picker and drops the token, never
// persisting or logging it.
export const createApp = (config: Config, prisma: PrismaClient, logger: Logger): { app: Hono<AppEnv>; auth: Auth } => {
    const auth = createAuth(config, prisma);

    const app = new Hono<AppEnv>();

    // Outermost: the OTel server span (@hono/otel). Registered first so the request logger and oRPC handlers
    // run inside the active span — their pino mixin then stamps logs with the span's trace_id/span_id.
    app.use(`*`, createTracingHttpMiddleware());

    // Then bind a per-request child logger (correlated by requestId) and log the completed request with
    // method/path/status/duration. Skips /health to avoid liveness-probe noise.
    app.use(`*`, async (c, next) => {
        const requestLogger = logger.child({ requestId: randomUUID() });
        c.set(`logger`, requestLogger);
        const start = performance.now();
        await next();
        if (c.req.path !== `/health`) {
            requestLogger.info(
                { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - start) },
                `request completed`,
            );
        }
    });

    // The SPA is served from webOrigin and calls this API cross-origin (there is no dev proxy), so CORS is
    // load-bearing, not a safety net. A rejected origin is otherwise invisible: Hono still answers the preflight
    // 204, just without Access-Control-Allow-Origin, so the browser blocks the real request before it is ever
    // sent — the API logs the OPTIONS and nothing else, and devtools blames "CORS". Log the mismatch instead.
    app.use(
        `*`,
        cors({
            origin: (origin, c) => {
                if (origin === config.webOrigin) {
                    return origin;
                }
                // Same-origin/server-to-server calls send no Origin at all; only a real mismatch is worth a warning.
                if (origin !== ``) {
                    c.get(`logger`).warn({ origin, expected: config.webOrigin }, `cors origin rejected`);
                }
                return null;
            },
            credentials: true,
        }),
    );
    app.use(`*`, secureHeaders({ crossOriginEmbedderPolicy: false }));

    // Better Auth owns everything under /api/auth (sign-in, OAuth callback, session, sign-out).
    app.on([`POST`, `GET`], `/api/auth/**`, (c: Context) => auth.handler(c.req.raw));

    app.get(`/health`, async (c) => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            return c.json({ status: `ok` });
        } catch (error) {
            return c.json({ status: `error`, message: error instanceof Error ? error.message : `unknown` }, 503);
        }
    });

    // The connect script (no session) redeems the setup code minted by sandbox.setupCode for the values the
    // install one-liner used to carry inline. Plain-text KEY=value lines — POSIX sh parses them with sed, no
    // JSON tooling on the user's box. The request logger records method/path/status only, so neither the code
    // nor the returned tokens are ever logged. 404 for unknown AND expired alike (no oracle).
    app.post(`/setup/claim`, async (c) => {
        const code = (await c.req.parseBody())[`code`];
        if (typeof code !== `string` || code === ``) {
            return c.text(`error: missing code`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { setupCode: code } });
        if (!sandbox || !sandbox.setupCodeExpiresAt || sandbox.setupCodeExpiresAt < new Date()) {
            return c.text(`error: setup code invalid or expired`, 404);
        }
        // token/setupPayload are encrypted at rest (crypto.ts); the payload is the encrypted JSON string
        // sandbox.setupCode stored.
        const payload =
            typeof sandbox.setupPayload === `string` ? (JSON.parse(decryptSecret(config, sandbox.setupPayload)) as Record<string, string>) : {};
        const lines = [`CONNECT_TOKEN=${decryptSecret(config, sandbox.token)}`];
        // Intentic path (marked by SANDBOX_HOSTNAME in the payload): the tunnel was provisioned when
        // sandbox.setupCode minted this code — the hostname must resolve before the wizard's first probe, or
        // resolvers negative-cache the NXDOMAIN — so just return the cached connector token. The own-Cloudflare
        // path carries ZONE/SUBDOMAIN and no hostname, and creates its own tunnel in the script.
        if (payload[`SANDBOX_HOSTNAME`] !== undefined && sandbox.tunnelToken !== null) {
            lines.push(`TUNNEL_TOKEN=${decryptSecret(config, sandbox.tunnelToken)}`);
        }
        // Single-use desktop-sync pairing token, minted per claim (the sandbox isn't running yet to mint its own).
        // The daemon arms it at boot; the connect script only runs the sync agent when SYNC_DIR was passed on the
        // command (the user's opt-in), so returning it unconditionally is harmless when sync is off.
        lines.push(`SYNC_PAIR_TOKEN=${randomBytes(32).toString(`base64url`)}`);
        lines.push(...Object.entries(payload).map(([key, value]) => `${key}=${value}`));
        return c.text(lines.join(`\n`));
    });

    // The daemon's phone-home: on boot + periodically it announces its public URL, authenticated by possession
    // of the connect token (x-intentic-connect — the same secret class /setup/claim's code redeems into). The
    // wizard polls sandbox.list for a fresh lastSeenAt instead of probing DNS-fragile hostnames from the
    // browser. 404 for unknown tokens (no oracle); the request logger records method/path/status only, so the
    // token never lands in logs.
    app.post(`/sandbox/announce`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { daemonUrl?: unknown } | undefined;
        const daemonUrl = body?.daemonUrl;
        if (typeof daemonUrl !== `string` || !isHttpsUrl(daemonUrl)) {
            return c.text(`error: daemonUrl must be an https URL`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { daemonUrl, lastSeenAt: new Date() } });
        return c.json({ ok: true });
    });

    // Mint an intentic-provided host SSH tunnel for the sandbox — the in-sandbox infra operator panel (which has
    // no browser session) requests it via the daemon, which relays here. Authenticated by the connect token like
    // /sandbox/announce; uses intentic's OWN Cloudflare account (the daemon has only the user's token). 404 for
    // unknown tokens (no oracle) and when intentic-provided tunnels aren't configured; the token never lands in logs.
    app.post(`/sandbox/host-tunnel`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { hostName?: unknown } | undefined;
        const hostName = body?.hostName;
        if (typeof hostName !== `string` || hostName === ``) {
            return c.text(`error: hostName is required`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        const { apiToken, zone } = config.intenticCloudflare;
        if (apiToken === `` || zone === ``) {
            return c.json({ error: `intentic-provided tunnels are not enabled` }, 404);
        }
        try {
            return c.json(await provisionHostSshTunnel({ apiToken, zone, connectToken: decryptSecret(config, sandbox.token), hostName }));
        } catch (error) {
            // A bad/under-scoped intentic token is the actionable case (400, like sandbox.zones); any other
            // Cloudflare failure is upstream (502).
            if (error instanceof CloudflareTokenError) {
                return c.json({ error: error.message }, 400);
            }
            return c.json({ error: error instanceof Error ? error.message : `host tunnel provisioning failed` }, 502);
        }
    });

    // Mint a panel's preview route (`preview-<panel>-<id>.<zone>` CNAME + tunnel ingress → the sandbox preview
    // proxy) on the sandbox's intentic-provided tunnel — the daemon relays here when a panel starts or a port
    // is forwarded, so the hostname resolves before the browser ever loads it. Authenticated by the connect token like
    // /sandbox/announce; 404 for unknown tokens (no oracle). Own-Cloudflare sandboxes (no cached tunnelToken)
    // are a no-op: their `*.<zone>` wildcard already serves the hostname.
    app.post(`/sandbox/preview-route`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { labels?: unknown } | undefined;
        const labels = body?.labels;
        if (!Array.isArray(labels) || labels.length === 0 || labels.length > 64 || !labels.every(validPreviewLabel)) {
            return c.text(`error: labels must be 1-64 lowercase DNS-safe preview-* or port-* names of at most 50 characters`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        if (sandbox.tunnelToken === null) {
            return c.json({ ok: true });
        }
        const { apiToken, zone } = config.intenticCloudflare;
        if (apiToken === `` || zone === ``) {
            return c.json({ error: `intentic-provided tunnels are not enabled` }, 404);
        }
        try {
            return c.json(
                await ensurePreviewRoutes({ apiToken, zone, connectToken: decryptSecret(config, sandbox.token), labels: labels as string[] }),
            );
        } catch (error) {
            // A bad/under-scoped intentic token is the actionable case (400, like sandbox.zones); any other
            // Cloudflare failure is upstream (502).
            if (error instanceof CloudflareTokenError) {
                return c.json({ error: error.message }, 400);
            }
            return c.json({ error: error instanceof Error ? error.message : `preview route provisioning failed` }, 502);
        }
    });

    const orpcHandler = new OpenAPIHandler(router, {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    // A client that vanished mid-request leaves the node request stream aborted, so oRPC's input
                    // decode throws `TypeError: Body is unusable` (node-server's fast path refuses a read on a
                    // disturbed stream). It answers a 400 nobody is left to receive — not worth a log line.
                    if (options.request.signal?.aborted === true) {
                        throw error;
                    }
                    // The per-request logger rides on the oRPC context (buildOrpcContext); fall back to root.
                    const log = (options.context as Partial<OrpcContext> | undefined)?.logger ?? logger;
                    logUnexpectedError(log, error);
                    throw error;
                }
            },
        ],
    });

    // Everything under /rpc flows through the oRPC OpenAPI handler, with the request logger on the context.
    app.all(`${API_BASE_PATH}/*`, async (c) => {
        const context = await buildOrpcContext({ auth, prisma, config, logger: c.get(`logger`) }, c.req.raw.headers);
        const result = await orpcHandler.handle(c.req.raw, { context, prefix: API_BASE_PATH });
        if (result.matched) {
            return result.response;
        }
        return c.notFound();
    });

    return { app, auth };
};
