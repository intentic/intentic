import { randomBytes, randomUUID } from "node:crypto";
import { API_BASE_PATH, BootReportSchema, SetupReportSchema } from "@intentic-app/api-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { type Context, Hono } from "hono";
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
import type { Logger } from "pino";
import { router } from "./router.js";
import { createTracingHttpMiddleware } from "./tracing.js";
import { mcpHttpRoutes } from "./mcp/mcp.routes.js";
import { poolHttpRoutes } from "./pool/pool.routes.js";
import { walletHttpRoutes } from "./wallet/wallet.routes.js";
import { trialRoutes } from "./trial/trial.routes.js";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";

type AppEnv = { Variables: { logger: Logger } };

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

/* WHERE A SANDBOX IS ALLOWED TO SAY IT LIVES.
 *
 * `daemonUrl` is not a passive record: the browser reads it out of the registry and sends the user's Google ID
 * token, or the daemon session minted from it, to whatever it names, unprobed (the tunnel candidate is the
 * one endpoint the browser never qualifies, because it IS the registry's own answer). So a `daemonUrl` an
 * attacker can write is a `daemonUrl` that harvests the owner's Google credential and replays it against the
 * real daemon. Announce is authenticated only by the connect token, which lives in the container's env, in a
 * compose file, and in whatever shell history ran the installer, a weaker secret than the identity it would
 * be trading up for. A platform-side compromise is the same story with no token needed at all, which is what
 * makes the "the platform holds nothing it could replay" claim (sandbox auth.ts) worth defending here.
 *
 * The address is not information the daemon actually contributes. A sandbox this platform made reachable
 * answers at `sandbox-<id>.<zone>`, a pure digest of its own connect token, known before the daemon ever
 * boots — so an announce that disagrees is either a misconfiguration or an attack, and neither deserves to be
 * written.
 *
 * The remaining case is a sandbox this platform never handed a grant to: an `attach`-only row, where the owner
 * runs the box behind a domain of their own and asserted the address themselves. There it pins on first
 * announce and holds: still not a free-form field, just one whose value is learned instead of derived.
 *
 * DID WE HAND THIS ROW A GRANT is asked of the row's own records rather than of a column, because there is no
 * column any more: reachability is a signature, not state (sandbox/reachability.ts). The two lanes that hand
 * one down are the two that leave a record — the setup mint stores its claim payload, and a hosted provision
 * creates the machine row — which is exactly the set the column this replaced used to mark. */
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
    // oRPC "expected" errors (UNAUTHORIZED, NOT_FOUND, …) are control flow, not incidents, don't log them.
    if (error instanceof ORPCError && error.code !== `INTERNAL_SERVER_ERROR`) {
        return;
    }
    log.error({ err: error }, `unexpected error`);
};

// The platform is the sandbox REGISTRY: each daemon announces its own URL + liveness here (outbound-only,
// authenticated by its connect token), and the browser reads the registry, then talks to the daemon DIRECTLY
// over its tunnel for everything else. No relay, no platform→sandbox calls, a breach still can't reach into
// any sandbox. The public (sessionless) routes are /setup/claim (the connect script redeems its setup code) and
// /api/reachability/<id> (the edge asks whether a registering tunnel's sandbox still exists), plus the
// connect-token-authenticated daemon relays /sandbox/announce (phone-home), /sandbox/boot-report and
// /sandbox/local-dns. sandbox.zones is the one route handed an infra secret (the Cloudflare token), and only
// transiently, it lists zones for the picker and drops the token, never persisting or logging it.
export const createApp = (config: Config, prisma: PrismaClient, logger: Logger): { app: Hono<AppEnv>; auth: Auth } => {
    const auth = createAuth(config, prisma);

    const app = new Hono<AppEnv>();

    // Outermost: the OTel server span (@hono/otel). Registered first so the request logger and oRPC handlers
    // run inside the active span, their pino mixin then stamps logs with the span's trace_id/span_id.
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
    // required, not a safety net. A rejected origin is otherwise invisible: Hono still answers the preflight
    // 204, just without Access-Control-Allow-Origin, so the browser blocks the real request before it is ever
    // sent, the API logs the OPTIONS and nothing else, and devtools blames "CORS". Log the mismatch instead.
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

    /* OAUTH DISCOVERY AT THE ROOT, where an MCP client actually looks. Better Auth serves both documents under
     * its own base path, and the 401 from /mcp points at them there, but RFC 8414 and RFC 9728 put them at the
     * ORIGIN root, and clients probe there first. Two aliases cost nothing and are the difference between
     * "Claude Code offers a sign-in" and "Claude Code says the server failed to connect".
     *
     * Public and CORS-open by design (the helpers set the headers): discovery metadata describes where to
     * authenticate, which is not a secret and is useless to anyone who cannot then complete the flow. */
    app.get(`/.well-known/oauth-authorization-server`, (c: Context) => oAuthDiscoveryMetadata(auth)(c.req.raw));
    app.get(`/.well-known/oauth-protected-resource`, (c: Context) => oAuthProtectedResourceMetadata(auth)(c.req.raw));
    // Same document, addressed by the resource path, what a client derives when the resource is /mcp.
    app.get(`/.well-known/oauth-protected-resource/mcp`, (c: Context) => oAuthProtectedResourceMetadata(auth)(c.req.raw));

    app.get(`/health`, async (c) => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            return c.json({ status: `ok` });
        } catch (error) {
            return c.json({ status: `error`, message: error instanceof Error ? error.message : `unknown` }, 503);
        }
    });

    // The connect script (no session) redeems the setup code minted by sandbox.setupCode for the values the
    // install one-liner used to carry inline. Plain-text KEY=value lines. POSIX sh parses them with sed, no
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
        const connectToken = decryptSecret(config, sandbox.token);
        const lines = [`CONNECT_TOKEN=${connectToken}`];
        // The loopback shortcut's host port, for the COMPOSE path only. Every other flow asks the image for its
        // run command and the run contract derives this from the same token (see @intentic/sandbox-run); a
        // compose file is written before the token exists, so it interpolates ${LOCAL_PORT} from this .env
        // instead. The browser derives the identical port from the token it holds, nothing is stored.
        const sandboxId = sandboxIdFromToken(connectToken);
        if (sandboxId !== undefined) {
            lines.push(`LOCAL_PORT=${localDaemonPort(sandboxId)}`);
        }
        // The reachability grant itself (SANDBOX_GRANT/INGRESS_URL/SANDBOX_HOSTNAME) rides in the stored
        // payload below, signed when the code was, so the box can dial the edge the moment it boots.
        // Single-use desktop-sync pairing token, minted per claim (the sandbox isn't running yet to mint its own).
        // The daemon arms it at boot; the connect script only runs the sync agent when SYNC_DIR was passed on the
        // command (the user's opt-in), so returning it unconditionally is harmless when sync is off.
        lines.push(`SYNC_PAIR_TOKEN=${randomBytes(32).toString(`base64url`)}`);
        // The same, for the CONNECTED-COMPUTER agent the flow installs beside it, so the machine running this
        // sandbox can be seen and managed from the browser instead of from a terminal on that machine. Minted
        // here for the same reason as the one above: nothing is running yet to mint it. Unconditional and inert
        // when unused, the daemon arms it once and burns it on redemption, and a flow that installs no agent
        // simply never spends it.
        lines.push(`HOST_PAIR_TOKEN=${randomBytes(32).toString(`base64url`)}`);
        lines.push(...Object.entries(payload).map(([key, value]) => `${key}=${value}`));
        // The one moment the platform learns the pasted command reached a machine. Everything after this point
        // happens inside the user's Docker and is invisible until the daemon announces minutes later, so the
        // setup wizard leans on this stamp to stop telling someone who has not opened a terminal that we are
        // waiting on their sandbox. Re-claimable, so this overwrites: the stamp marks the LATEST attempt,
        // and the previous attempt's setup report is cleared with it, so a fixed-and-re-run machine never
        // shows last time's failure over this run's progress.
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { setupCodeClaimedAt: new Date(), setupReport: Prisma.DbNull } });
        return c.text(lines.join(`\n`));
    });

    /* The machine-side setup narrator (issue: the wizard could only guess by elapsed time). ic POSTs each
     * stage transition and any terminal failure here, with each broken check's problem AND its fix, so the
     * browser names why a setup died even when the terminal that knew is long closed. Possession of a live
     * setup code is the auth, exactly the claim's trust; the code stays valid until expiry, so a failure
     * BEFORE the claim (Docker not running) reaches the wizard too. `at` is stamped here, the reporting
     * machine's clock is never trusted. */
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

    // The daemon's phone-home: on boot + periodically it announces its public URL, authenticated by possession
    // of the connect token (x-intentic-connect, the same secret class /setup/claim's code redeems into). The
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
        // `hosted` rides along because it is half of "did we hand this row a grant" (expectedDaemonHost): a
        // hosted machine's address is ours by construction, and its row is the only record saying so.
        const sandbox = await prisma.sandbox.findUnique({
            where: { tokenDigest: sha256Hex(token) },
            include: { hosted: { select: { id: true } } },
        });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        /* The browser trusts this value with the user's Google credential, so it is pinned to the address we
         * already know this sandbox by (see expectedDaemonHost). A daemon that announces anything else is
         * refused and the stored URL is left alone, lastSeenAt too, so the sandbox reads as not-phoning-home
         * rather than quietly alive at an address nobody vetted.
         *
         * The refused HOST is recorded, though, because the refusal is otherwise a perfect silence: the box
         * retries, we say no, and the wizard shows the same spinner it shows a machine that never booted. It
         * is not secret (it is the address the sandbox itself just claimed) and it is the whole diagnosis, a
         * sandbox announcing somewhere other than where we expect it is a misconfiguration with a name. */
        const expected = expectedDaemonHost(config, sandbox);
        if (expected !== undefined && hostOf(daemonUrl) !== expected) {
            c.get(`logger`).warn({ sandboxId: sandbox.id, announced: hostOf(daemonUrl), expected }, `announce rejected: daemonUrl host mismatch`);
            await prisma.sandbox.update({
                where: { id: sandbox.id },
                data: { announceRefusal: { announced: hostOf(daemonUrl) ?? daemonUrl, expected } },
            });
            return c.text(`error: this sandbox announces at ${expected}`, 409);
        }
        // Cleared on the way through: a stored refusal must describe a LIVE disagreement, and a sandbox that
        // has just been accepted at its proper address no longer has one. firstAnnouncedAt is the activation
        // moment, written exactly once — the loaded row says whether this announce is the first accepted one
        // (two racing first announces would stamp the same moment, which is the same fact).
        await prisma.sandbox.update({
            where: { id: sandbox.id },
            data: {
                daemonUrl,
                lastSeenAt: new Date(),
                announceRefusal: Prisma.DbNull,
                ...(sandbox.firstAnnouncedAt === null ? { firstAnnouncedAt: new Date() } : {}),
            },
        });
        return c.json({ ok: true });
    });

    /* THE DAEMON'S BOOT REPORT, the announce's other half, and the half that was missing. An announce says
     * "I started"; this says "and my public address answers", which the box establishes by asking that address
     * itself from the inside. They are separate routes because they are separate claims and they fail
     * separately: the tunnel migration produced a fleet of sandboxes that announced perfectly and could not be
     * reached, and nothing in the registry could tell them apart from healthy ones.
     *
     * Authenticated by the connect token exactly like the announce, the same secret, the same outbound path,
     * and deliberately not the tunnel, so the report still arrives when the tunnel is what is broken. `at` is
     * stamped here; the reporting machine's clock is never trusted. */
    app.post(`/sandbox/boot-report`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        const body = (await c.req.json().catch(() => undefined)) as { reach?: unknown; detail?: unknown } | undefined;
        const report = BootReportSchema.safeParse({ reach: body?.reach, detail: body?.detail, at: new Date().toISOString() });
        if (!report.success) {
            return c.text(`error: malformed report`, 400);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return c.text(`error: unknown sandbox`, 404);
        }
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { bootReport: report.data } });
        return c.json({ ok: true });
    });

    /* The two Cloudflare relays that used to live here (POST /sandbox/host-tunnel, POST /sandbox/preview-route)
     * are gone with the tunnels they minted. A sandbox's names all live under ONE wildcard the edge routes by
     * name, and the leftmost label carries the sandbox's own id, so every name a box serves (panels, forwarded
     * ports, the public outbox) is one it can prove it owns with the grant it already holds. The platform is
     * not on the naming path at all, which is one fewer thing a compromised platform could do to a sandbox. */

    /* IS THIS SANDBOX STILL A SANDBOX, AND HOW IS IT REACHED? The ingress asks on every tunnel registration,
     * and the answer is the whole of revocation under this fabric: a grant carries no expiry (it lives in a
     * container's env for the container's life), so "this box may no longer be reached" has to be a question
     * somebody can ask, and the only party that knows is the registry. 200 the row exists, 404 it does not —
     * and a 404 is what makes deleting a sandbox the act that takes its address away (sandbox/reachability.ts).
     *
     * The edge asks the same question for a hostname no tunnel holds, because the answer decides what it does
     * next: a HOSTED sandbox is one the platform runs on Fly, reached by replaying the request to its app
     * (`lane: "hosted"`, with the app named so the edge need not derive it), while a sandbox on somebody's own
     * machine is reached only by the tunnel it dials, so a missing tunnel is simply "not connected". A row that
     * has no hosted machine yet answers `tunnel`, since nothing can be replayed to.
     *
     * UNAUTHENTICATED, on purpose. What it discloses is whether a 12-hex id names a live sandbox and whether
     * the platform runs its machine, and that id is the leading label of every URL its owner has ever shared:
     * existence is not a secret, and the address itself already answers this question to anyone who loads it.
     * Guessing one is guessing 48 bits, and a guess that lands still learns nothing but "yes". Signing this
     * would mean giving the edge a credential to hold for a fact the edge could read off DNS.
     *
     * Resolved by exact match on the stored `tunnelId` — the row's own copy of the derivation, written at
     * creation (sandbox.routes create). The id is the first 12 hex of `tokenDigest`, so this LOOKS like a
     * prefix query on a column that already exists, and that is exactly what it must not be: Postgres cannot
     * use a default-collation btree index for `LIKE 'prefix%'`, so the honest reading of the same fact costs a
     * sequential scan of every sandbox on the platform, on the path a fleet-wide restart hits at once. The
     * column is also `@unique`, which is not decoration: two rows sharing a 12-hex id would fight over every
     * hostname either one serves, and the constraint is where that becomes impossible rather than unlikely. */
    app.get(`/api/reachability/:sandboxId`, async (c) => {
        const sandboxId = c.req.param(`sandboxId`);
        // Shape-checked before the query: the id is a fixed alphabet and length, so anything else is not a
        // sandbox that could exist and is answered without asking the database.
        if (!/^[0-9a-f]{12}$/.test(sandboxId)) {
            return c.json({ error: `not a sandbox id` }, 404);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tunnelId: sandboxId }, select: { id: true, hosted: { select: { appName: true } } } });
        if (sandbox === null) {
            return c.json({ error: `unknown sandbox` }, 404);
        }
        return c.json(sandbox.hosted === null ? { ok: true, lane: `tunnel` } : { ok: true, lane: `hosted`, app: sandbox.hosted.appName });
    });

    /* The LOOPBACK CERTIFICATE's DNS relay, kept through the tunnel migration because it is not a tunnel: a
     * sandbox on the same machine as the browser is reached at 127.0.0.1, and that address still needs a real
     * certificate (`<id>.local.<zone>`, an unproxied A record plus the ACME TXT of one order). The daemon
     * drives its own issuance and holds the key; it relays here for these two records only, because on the
     * platform's zone it has no token of its own. This is the whole of what Cloudflare still does for a
     * sandbox: DNS, never traffic. Authenticated by the connect token like /sandbox/announce. */
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
                    // A client that vanished mid-request leaves the node request stream aborted, so oRPC's input
                    // decode throws `TypeError: Body is unusable` (node-server's fast path refuses a read on a
                    // disturbed stream). It answers a 400 nobody is left to receive, not worth a log line.
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

    /* The free trial's model API, the one route family the platform serves ON the command path, mounted as its
     * own sub-app so that exception has a boundary you can point at (see trial/trial.routes.ts). Off unless
     * TRIAL_KEYS is set, which is the default and the only sane setting for a self-hosted platform: with no keys
     * every route under here 404s and the daemon provisions no trial endpoint. */
    app.route(`/trial`, trialRoutes({ config, prisma }));

    /* The creator pool's non-browser routes, the daemon's ledger report + premium probe, Stripe's webhook,
     * and the public transparency read (see pool/pool.routes.ts). Off unless POOL_STRIPE_SECRET_KEY +
     * POOL_STRIPE_PRICE_ID are set, the trial's pattern: unset, everything under here 404s and no surface
     * anywhere offers a membership. */
    app.route(`/pool`, poolHttpRoutes({ config, prisma, auth }));

    /* The agent wallet's signer, a sandbox's two connect-token routes (see wallet/wallet.routes.ts): make
     * this member's wallet, and mint one EIP-712 signature over one fully-specified USDC transfer, with the
     * owner's caps re-checked HERE against this database rather than trusted from the container. Off unless
     * WALLET_CUSTODY_URL + WALLET_CUSTODY_KEY are set, the pool's pattern: unset, everything under here
     * 404s, no key material exists anywhere, and a sandbox's wallet card stays pending and says so. */
    app.route(`/wallet`, walletHttpRoutes({ config, prisma }));

    /* THE MCP DOOR, the same services catalog, reached by a coding agent that has no sandbox (see
     * mcp/mcp.routes.ts). Authenticated by an OAuth bearer this platform issued rather than by a connect
     * token, which is what lets somebody buy and spend a membership without owning a machine. Same pool
     * switch: no Stripe price, no door.
     *
     * `demoDispatch` is the same in-process forward the pool route uses for the demo service, for the same
     * reason: the platform's own https address is not reliably reachable from the platform. */
    app.route(
        `/mcp`,
        mcpHttpRoutes({
            config,
            prisma,
            auth,
            demoDispatch: (async (url: string | URL | Request, init?: RequestInit) =>
                app.request(new URL(String(url)).pathname, init)) as typeof fetch,
        }),
    );

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
