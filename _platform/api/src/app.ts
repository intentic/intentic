import { randomBytes, randomUUID } from "node:crypto";
import { API_BASE_PATH, BootReportSchema, SetupReportSchema } from "@intentic/api-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { type Auth, createAuth } from "./auth.js";
import { localHostname } from "@intentic/sandbox-contract";
import { CloudflareTokenError, ensureLocalDnsRecord, setAcmeChallenge } from "./sandbox/cloudflare.js";
import { ingressEnabled, sandboxHostname } from "./sandbox/reachability.js";
import type { Config } from "./config.js";
import { buildOrpcContext, type OrpcContext } from "./context.js";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { decryptSecret } from "./crypto.js";
import { reportHostedBuild } from "./sandbox/hosted/build/hosted-build.js";
import { LOG_TAIL_BYTES, REPORT_HEADERS } from "./sandbox/hosted/build/hosted-build-script.js";
import type { Logger } from "pino";
import { router } from "./router.js";
import { createTracingHttpMiddleware } from "./tracing.js";
import { hostedPlanHttpRoutes } from "./sandbox/hosted/hosted-plan.routes.js";
import { walletHttpRoutes } from "./wallet/wallet.routes.js";
import { trialRoutes } from "./trial/trial.routes.js";
import { Prisma, type PrismaClient } from "@intentic/prisma";

type AppEnv = { Variables: { logger: Logger } };

// The request-body ceilings (see the middleware in createApp): the platform's, and the trial's larger one.
const BODY_LIMIT_BYTES = 1024 * 1024;
const TRIAL_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

// Accept only a valid https origin so a bogus value can't be stored as the sandbox's address.
const isHttpsUrl = (value: string): boolean => {
    try {
        return new URL(value).protocol === `https:`;
    } catch {
        return false;
    }
};

const hostOf = (url: string): string | undefined => {
    try {
        return new URL(url).host;
    } catch {
        return undefined;
    }
};

// Derives the address a sandbox may announce, from its connect token, when the platform handed the row a grant (setup
// payload or hosted machine); an attach-only row has no derivation and pins on whatever announce first records.
const expectedDaemonHost = (
    config: Config,
    sandbox: { token: string; setupPayload: unknown; daemonUrl: string | null; hosted?: { id: string } | null },
): string | undefined => {
    const handedAGrant = sandbox.setupPayload !== null || (sandbox.hosted ?? null) !== null;
    if (handedAGrant && ingressEnabled(config)) {
        return sandboxHostname(config.ingress.zone, decryptSecret(config, sandbox.token));
    }
    return sandbox.daemonUrl === null ? undefined : hostOf(sandbox.daemonUrl);
};

const logUnexpectedError = (log: Logger, error: unknown): void => {
    // oRPC's own errors (UNAUTHORIZED, NOT_FOUND, ...) are control flow, not incidents; skip logging them.
    if (error instanceof ORPCError && error.code !== `INTERNAL_SERVER_ERROR`) {
        return;
    }
    log.error({ err: error }, `unexpected error`);
};

// The platform is a sandbox registry, never a relay: daemons announce over their own tunnel, the browser talks to them
// directly. Public routes are /setup/claim and /api/reachability/:id; the rest are connect-token-authenticated relays.
export const createApp = (config: Config, prisma: PrismaClient, logger: Logger): { app: Hono<AppEnv>; auth: Auth } => {
    const auth = createAuth(config, prisma, logger);

    const app = new Hono<AppEnv>();

    // Outermost: the OTel server span, registered first so the request logger and oRPC handlers run inside it.
    app.use(`*`, createTracingHttpMiddleware());

    // Per-request child logger (by requestId); logs the completed request, skipping /health to avoid probe noise.
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

    // CORS is required, not a safety net: the SPA calls this API cross-origin with no dev proxy.
    app.use(
        `*`,
        cors({
            origin: (origin, c) => {
                if (origin === config.webOrigin) {
                    return origin;
                }
                // Same-origin/server calls send no Origin at all; only a real mismatch is worth a warning.
                if (origin !== ``) {
                    c.get(`logger`).warn({ origin, expected: config.webOrigin }, `cors origin rejected`);
                }
                return null;
            },
            credentials: true,
        }),
    );
    app.use(`*`, secureHeaders({ crossOriginEmbedderPolicy: false }));

    /* HOW MUCH BODY A REQUEST MAY CARRY, decided before any route reads one. Hono buffers a JSON body whole
     * and Node puts no ceiling under that, so every route that parses before it looks anything up
     * (/setup/claim, /setup/report, /sandbox/announce, all sessionless) was a way to hand this process as much
     * heap as a client cared to send, and the authenticated ones were no better once past their token check.
     * A megabyte covers everything the platform is legitimately sent; the largest body in the contract is a
     * sandbox logo (ImageDataUrlSchema, 150 KB). The trial's chat completions are the exception and get a
     * ceiling of their own: a conversation is sent whole on every turn, and a long one with tool output in it
     * runs to megabytes. The build report keeps the tighter cap it declares itself. A Content-Length over the
     * limit is refused before a byte is read; a chunked body is read up to the limit and no further. */
    app.use(`*`, (c, next) =>
        bodyLimit({
            maxSize: c.req.path.startsWith(`/trial/`) ? TRIAL_BODY_LIMIT_BYTES : BODY_LIMIT_BYTES,
            onError: (refused) => refused.text(`error: request body too large`, 413),
        })(c, next),
    );

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

    // The connect script redeems the setup code for plain KEY=value lines; 404 for unknown and expired alike.
    app.post(`/setup/claim`, async (c) => {
        const code = (await c.req.parseBody())[`code`];
        if (typeof code !== `string` || code === ``) {
            return c.text(`error: missing code`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { setupCode: code } });
        if (!sandbox || !sandbox.setupCodeExpiresAt || sandbox.setupCodeExpiresAt < new Date()) {
            return c.text(`error: setup code invalid or expired`, 404);
        }
        // token/setupPayload are encrypted at rest (crypto.ts); payload is the decrypted JSON sandbox.setupCode stored.
        const payload =
            typeof sandbox.setupPayload === `string` ? (JSON.parse(decryptSecret(config, sandbox.setupPayload)) as Record<string, string>) : {};
        const connectToken = decryptSecret(config, sandbox.token);
        const lines = [`CONNECT_TOKEN=${connectToken}`];
        // Loopback host port for the compose path only; the browser derives the same port from its own token.
        const sandboxId = sandboxIdFromToken(connectToken);
        if (sandboxId !== undefined) {
            lines.push(`LOCAL_PORT=${localDaemonPort(sandboxId)}`);
        }
        // Single-use desktop-sync pairing token, minted per claim since the sandbox isn't running yet to mint its own.
        lines.push(`SYNC_PAIR_TOKEN=${randomBytes(32).toString(`base64url`)}`);
        // Same, for the connected-computer agent installed beside it; unconditional and inert when unused.
        lines.push(`HOST_PAIR_TOKEN=${randomBytes(32).toString(`base64url`)}`);
        lines.push(...Object.entries(payload).map(([key, value]) => `${key}=${value}`));
        // Re-claimable: overwrites the stamp and clears the prior setupReport, so a re-run hides last run's failure.
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { setupCodeClaimedAt: new Date(), setupReport: Prisma.DbNull } });
        return c.text(lines.join(`\n`));
    });

    // The machine-side setup narrator; possession of a live setup code is the auth, same trust as the claim.
    app.post(`/setup/report`, async (c) => {
        const body = (await c.req.json().catch(() => undefined)) as { code?: unknown; stage?: unknown; failed?: unknown } | undefined;
        const code = body?.code;
        if (typeof code !== `string` || code === ``) {
            return c.text(`error: missing code`, 400);
        }
        const report = SetupReportSchema.safeParse({ stage: body?.stage, failed: body?.failed ?? [], at: new Date().toISOString() });
        if (!report.success) {
            return c.text(`error: malformed report`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { setupCode: code } });
        if (!sandbox || !sandbox.setupCodeExpiresAt || sandbox.setupCodeExpiresAt < new Date()) {
            return c.text(`error: setup code invalid or expired`, 404);
        }
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { setupReport: report.data } });
        return c.text(`ok`);
    });

    // The daemon's phone-home, authenticated by the connect token; 404 for unknown tokens (no oracle).
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
        // `hosted` rides along: a hosted machine's address is ours by construction, and its row is what says so.
        const sandbox = await prisma.sandbox.findUnique({
            where: { tokenDigest: sha256Hex(token) },
            include: { hosted: { select: { id: true } } },
        });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        // Pinned to the address already known for this sandbox; a mismatch is refused and recorded, nothing else moves.
        const expected = expectedDaemonHost(config, sandbox);
        if (expected !== undefined && hostOf(daemonUrl) !== expected) {
            c.get(`logger`).warn({ sandboxId: sandbox.id, announced: hostOf(daemonUrl), expected }, `announce rejected: daemonUrl host mismatch`);
            await prisma.sandbox.updateMany({
                where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
                data: { announceRefusal: { announced: hostOf(daemonUrl) ?? daemonUrl, expected } },
            });
            return c.text(`error: this sandbox announces at ${expected}`, 409);
        }
        // Cleared here since a stored refusal must describe a live disagreement; firstAnnouncedAt is written once.
        const announced = await prisma.sandbox.updateMany({
            where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
            data: {
                daemonUrl,
                lastSeenAt: new Date(),
                announceRefusal: Prisma.DbNull,
                ...(sandbox.firstAnnouncedAt === null ? { firstAnnouncedAt: new Date() } : {}),
            },
        });
        return announced.count === 0 ? c.text(`error: unknown sandbox`, 404) : c.json({ ok: true });
    });

    /* HOW A SANDBOX PRESENTS ITSELF, read by the sandbox itself. Same sessionless door as announce above and the
     * same credential (possession of the connect token), because the caller is the daemon, not a browser.
     *
     * It exists for portability. A sandbox's display name and switcher logo are columns on this row and live
     * nowhere in /work or /history, so the daemon does not know either one — which meant a bundle could not carry
     * them and a migrated sandbox arrived wearing the auto-name it was minted with. The daemon asks for them when
     * it packs a bundle, writes them into the manifest, and the target's browser applies them through
     * `sandbox.update` after the arrival.
     *
     * Read-only, and narrower than the row: no token, no daemonUrl, nothing another lane could use. */
    app.post(`/sandbox/presentation`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { tokenDigest: sha256Hex(token) },
            select: { name: true, image: true },
        });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        return c.json({ name: sandbox.name, ...(sandbox.image === null ? {} : { image: sandbox.image }) });
    });

    // A builder's report, authenticated by its per-build secret; body capped twice against an abusive caller.
    app.post(`/sandbox/hosted-build-report/:buildId`, bodyLimit({ maxSize: 2 * LOG_TAIL_BYTES }), async (c) => {
        const secret = c.req.header(REPORT_HEADERS.secret);
        if (secret === undefined || secret === ``) {
            return c.text(`error: missing build secret`, 400);
        }
        const exitHeader = c.req.header(REPORT_HEADERS.exitCode) ?? ``;
        const exitCode = /^-?\d+$/.test(exitHeader) ? Number(exitHeader) : undefined;
        const digest = c.req.header(REPORT_HEADERS.digest) ?? ``;
        const log = await c.req.text().catch(() => ``);
        const answer = await reportHostedBuild(prisma, config, c.get(`logger`), c.req.param(`buildId`), secret, {
            exitCode,
            digest: /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined,
            log,
        });
        switch (answer) {
            case `unknown`:
                return c.text(`error: unknown build`, 404);
            case `forbidden`:
                return c.text(`error: wrong build secret`, 403);
            case `stale`:
                return c.text(`error: this build has already ended`, 409);
            default:
                return c.json({ ok: true });
        }
    });

    // The announce's other half: whether the public address answers, authenticated the same way, same path.
    app.post(`/sandbox/boot-report`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { reach?: unknown; detail?: unknown; boot?: unknown; cpu?: unknown } | undefined;
        const report = BootReportSchema.safeParse({
            reach: body?.reach,
            detail: body?.detail,
            boot: body?.boot,
            cpu: body?.cpu,
            at: new Date().toISOString(),
        });
        if (!report.success) {
            return c.text(`error: malformed report`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        const updated = await prisma.sandbox.updateMany({
            where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
            data: { bootReport: report.data },
        });
        return updated.count === 0 ? c.text(`error: unknown sandbox`, 404) : c.json({ ok: true });
    });

    // Unauthenticated by design (existence isn't secret); matches `tunnelId` exactly, never a prefix over it.
    app.get(`/api/reachability/:sandboxId`, async (c) => {
        const sandboxId = c.req.param(`sandboxId`);
        // Shape-checked before the query: outside the fixed alphabet/length can't be a sandbox, skip the database.
        if (!/^[0-9a-f]{12}$/.test(sandboxId)) {
            return c.json({ error: `not a sandbox id` }, 404);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { tunnelId: sandboxId },
            select: { id: true, hosted: { select: { appName: true } } },
        });
        if (sandbox === null) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json(sandbox.hosted === null ? { ok: true, lane: `tunnel` } : { ok: true, lane: `hosted`, app: sandbox.hosted.appName });
    });

    // The loopback certificate's DNS relay: a same-machine sandbox still needs a real cert for 127.0.0.1.
    app.post(`/sandbox/local-dns`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { challenge?: unknown } | undefined;
        const challenge = body?.challenge;
        if (challenge !== undefined && (typeof challenge !== `string` || challenge.length > 128)) {
            return c.text(`error: challenge must be a string of at most 128 characters`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        const { apiToken, zone } = config.intenticCloudflare;
        if (apiToken === `` || zone === ``) {
            return c.json({ error: `the loopback-certificate path is not enabled on this platform` }, 404);
        }
        const sandboxId = sandboxIdFromToken(decryptSecret(config, sandbox.token));
        if (sandboxId === undefined) {
            return c.json({ error: `this sandbox has no connect token to derive a hostname from` }, 404);
        }
        const hostname = localHostname(sandboxId, zone);
        try {
            await ensureLocalDnsRecord(apiToken, zone);
            await setAcmeChallenge(apiToken, zone, `_acme-challenge.${hostname}`, challenge as string | undefined);
            return c.json({ ok: true, hostname });
        } catch (error) {
            if (error instanceof CloudflareTokenError) {
                return c.json({ error: error.message }, 400);
            }
            return c.json({ error: error instanceof Error ? error.message : `local DNS update failed` }, 502);
        }
    });

    const orpcHandler = new OpenAPIHandler(router, {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    // A client that vanished mid-request aborts the stream; oRPC's decode throws, and nobody is left to
                    // log it for.
                    if (options.request.signal?.aborted === true) {
                        throw error;
                    }
                    // The per-request logger rides the oRPC context; fall back to the root logger if absent.
                    const log = (options.context as Partial<OrpcContext> | undefined)?.logger ?? logger;
                    logUnexpectedError(log, error);
                    throw error;
                }
            },
        ],
    });

    // The free trial's model API, mounted as its own sub-app; off (404s) unless TRIAL_KEYS is set.
    app.route(`/trial`, trialRoutes({ config, prisma }));

    // The hosted plan's one non-browser route, Stripe's webhook; off (404s) unless its Stripe keys are set.
    app.route(`/hosted-plan`, hostedPlanHttpRoutes({ config, prisma }));

    // The agent wallet's signer routes; caps are re-checked here against the database, never trusted from a box.
    app.route(`/wallet`, walletHttpRoutes({ config, prisma }));

    // Everything under /rpc flows through the oRPC OpenAPI handler, with the request logger on the context.
    app.all(`${API_BASE_PATH}/*`, async (c) => {
        const context = await buildOrpcContext({ auth, prisma, config, logger: c.get(`logger`) }, c.req.raw.headers);
        const result = await orpcHandler.handle(c.req.raw, { context, prefix: API_BASE_PATH });
        if (result.matched) {
            const cookies = context.sessionHeaders.getSetCookie();
            if (cookies.length === 0) {
                return result.response;
            }
            const headers = new Headers(result.response.headers);
            for (const cookie of cookies) {
                headers.append(`set-cookie`, cookie);
            }
            return new Response(result.response.body, {
                status: result.response.status,
                statusText: result.response.statusText,
                headers,
            });
        }
        return c.notFound();
    });

    return { app, auth };
};
