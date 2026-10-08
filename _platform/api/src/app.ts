import { randomBytes, randomUUID } from "node:crypto";
import { API_BASE_PATH, type BootReport, type SetupReport } from "@intentic/api-contract";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { type Auth, createAuth } from "./auth.js";
import { adminUpstreamRoutes } from "./admin/admin-upstream.routes.js";
import { localHostname, SANDBOX_ID } from "@intentic/sandbox-contract";
import { acmeChallengeHolds, CloudflareTokenError, ensureLocalDnsRecord, setAcmeChallenge } from "./sandbox/cloudflare.js";
import { edgeCertificateFor } from "./sandbox/edge-certificate.js";
import { hostReportHttpRoutes } from "./sandbox/host-report.js";
import { ingressEnabled, sandboxHostname } from "./sandbox/reachability.js";
import { DaemonVersionSchema } from "./sandbox/daemon-version.js";
import { identityField, isTombstoned } from "./sandbox/recovery.js";
import { announcedCopyOf, noteAnnounce, seenCopiesOf } from "./sandbox/announce-copies.js";
import { claimerOf, heldClaimerOf, namesMachine, secondMachine } from "./sandbox/setup-code.js";
import { recoveryHttpRoutes } from "./sandbox/recovery.routes.js";
import type { Config } from "./config.js";
import { buildOrpcContext, type OrpcContext } from "./context.js";
import { ingressServer } from "./ingress.js";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { localDaemonPort } from "@intentic/sandbox-run";
import { decryptSecret } from "./crypto.js";
import { reportHostedBuild } from "./sandbox/hosted/build/hosted-build.js";
import { LOG_TAIL_BYTES, REPORT_HEADERS } from "./sandbox/hosted/build/hosted-build-script.js";
import type { Logger } from "pino";
import { router } from "./router.js";
import { createTracingHttpMiddleware } from "./tracing.js";
import { hostedPlanHttpRoutes } from "./sandbox/hosted/plan/hosted-plan.routes.js";
import { fleetHttpRoutes } from "./fleet/fleet.routes.js";
import { walletHttpRoutes } from "./wallet/wallet.routes.js";
import { trialRoutes } from "./trial/trial.routes.js";
import { Prisma, type PrismaClient } from "@intentic/prisma";

// `Bindings` is Bun's server as Bun.serve hands it to `fetch`, of which only the per-request idle timeout is used; it is
// absent wherever the app is not served by Bun (the suites' app.request).
type AppEnv = { Bindings: { readonly timeout?: (request: Request, seconds: number) => void } | undefined; Variables: { logger: Logger } };

// The request-body ceilings (see the middleware in createApp): the platform's, and the trial's larger one.
const BODY_LIMIT_BYTES = 1024 * 1024;
const TRIAL_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/* THE ROUTES THAT CHANGE A HOSTED MACHINE AND WAIT FOR IT. A restart, a rollback or a rebuild's swap waits for the new
 * version's daemon to come up (minutes, sandbox/hosted/gate/daemon-health.ts), a wake for a heal or a judged start, a
 * provision for a machine to start, a tier change for a move. Bun closes a request that has sent nothing for its idle
 * timeout (10s by default) with no response at all, which cut the owner off from the answer, the reason a version was
 * put back included, while the change went on without them; these lift it for themselves. */
const MACHINE_CHANGE_PATHS = new Set(
    [
        `/sandbox/hosted-restart`,
        `/sandbox/hosted-rollback`,
        `/sandbox/hosted-rebuild`,
        `/sandbox/wake`,
        `/sandbox/hosted-provision`,
        `/hosted-plan/tier`,
    ].map((path) => `${API_BASE_PATH}${path}`),
);

const keepMachineChangesOpen: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (MACHINE_CHANGE_PATHS.has(c.req.path)) {
        c.env?.timeout?.(c.req.raw, 0);
    }
    await next();
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
// directly. Public routes are /setup/claim, /api/reachability/:id and /api/identity; the rest are connect-token-authenticated
// relays.
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

    /* HOW MUCH BODY A REQUEST MAY CARRY, decided before any route reads one. */
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

    // The connect script redeems the setup code for plain KEY=value lines; 404 for unknown and expired alike. Beside
    // `code`, an `ic` new enough names the machine claiming (`host`, `os`, `instance`; setup-code.ts): the first claim
    // that does is recorded, and the same code claimed by a different machine is refused with 409 while it lives, so one
    // pasted command cannot start two copies of a sandbox (2026-10-05). The same machine running it again is let through.
    // Every route a machine calls is registered under its entry in api-contract's PLATFORM_INGRESS (ingress.ts).
    const ingress = ingressServer(app);

    ingress(`setupClaim`, async (c, kit) => {
        const form = await kit.body();
        if (form === undefined) {
            return kit.refuse(400, `missing code`);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { setupCode: form.code } });
        if (!sandbox || !sandbox.setupCodeExpiresAt || sandbox.setupCodeExpiresAt < new Date()) {
            return kit.refuse(404, `setup code invalid or expired`);
        }
        const claimer = claimerOf(form);
        const refusal = secondMachine(sandbox, claimer);
        if (refusal !== undefined) {
            c.get(`logger`).warn(
                { sandboxId: sandbox.id, held: sandbox.setupClaimedBy, claimer },
                `setup claim refused: the code was already used on another machine`,
            );
            return kit.refuse(409, refusal);
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
        // Re-claimable: overwrites the stamp and clears the prior setupReport, so a re-run hides last run's failure. The
        // first machine to name itself is kept for the code's life; a later one is the same machine, or was refused above.
        const now = new Date();
        const recordClaimer = namesMachine(claimer) && heldClaimerOf(sandbox.setupClaimedBy) === undefined;
        await prisma.sandbox.update({
            where: { id: sandbox.id },
            data: {
                setupCodeClaimedAt: now,
                setupReport: Prisma.DbNull,
                ...(recordClaimer ? { setupClaimedBy: { ...claimer, at: now.toISOString() } } : {}),
            },
        });
        return c.text(lines.join(`\n`));
    });

    // The machine-side setup narrator; possession of a live setup code is the auth, same trust as the claim.
    ingress(`setupReport`, async (c, kit) => {
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `malformed report: a setup report names its live code, its stage and what failed`);
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { setupCode: body.code } });
        if (!sandbox || !sandbox.setupCodeExpiresAt || sandbox.setupCodeExpiresAt < new Date()) {
            return kit.refuse(404, `setup code invalid or expired`);
        }
        const report: SetupReport = { stage: body.stage, failed: body.failed, at: new Date().toISOString() };
        await prisma.sandbox.update({ where: { id: sandbox.id }, data: { setupReport: report } });
        return c.text(`ok`);
    });

    // What `ic sandbox fix` found on the machine a sandbox runs on: `/host-report/claim` redeems the recovery panel's fix
    // code for the report key, `/host-report` takes a report under that key (sandbox/host-report.ts).
    app.route(`/host-report`, hostReportHttpRoutes({ config, prisma }));

    // The daemon's phone-home, authenticated by the connect token. A token with no row answers 410 when its id has a
    // deletion record, else 404: the second is what a registry that forgot the sandbox says, and the daemon keeps
    // asking (and its owner can have it adopted, POST /sandbox/adopt), where the first is final. Telling them apart
    // takes possessing the token, so neither is an oracle. An accepted announce answers with this database's identity.
    // (2026-10-05) A daemon sends it again every hour once registered, so `lastSeenAt` is its heartbeat rather than its
    // registration; and one new enough names which copy it is, which the row keeps to tell two containers on one token
    // apart from one that restarted (announce-copies.ts).
    ingress(`announce`, async (c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `daemonUrl must be an https URL`);
        }
        const { daemonUrl } = body;
        // Stored as the daemon names itself; null for a daemon too old to say, so the row never keeps a stale one.
        const version = DaemonVersionSchema.safeParse(body.version);
        if (!version.success && body.version !== undefined) {
            c.get(`logger`).warn({ version: String(body.version).slice(0, 80) }, `announce: the version named is not one; not stored`);
        }
        // `hosted` rides along: a hosted machine's address is ours by construction, and its row is what says so.
        const sandbox = await prisma.sandbox.findUnique({
            where: { tokenDigest: sha256Hex(token) },
            include: { hosted: { select: { id: true } } },
        });
        if (!sandbox) {
            const tunnelId = sandboxIdFromToken(token);
            return tunnelId !== undefined && (await isTombstoned(prisma, tunnelId))
                ? kit.refuse(410, `this sandbox was deleted`)
                : kit.refuse(404, `unknown sandbox`);
        }
        // Pinned to the address already known for this sandbox; a mismatch is refused and recorded, nothing else moves.
        const expected = expectedDaemonHost(config, sandbox);
        if (expected !== undefined && hostOf(daemonUrl) !== expected) {
            c.get(`logger`).warn({ sandboxId: sandbox.id, announced: hostOf(daemonUrl), expected }, `announce rejected: daemonUrl host mismatch`);
            await prisma.sandbox.updateMany({
                where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
                data: { announceRefusal: { announced: hostOf(daemonUrl) ?? daemonUrl, expected } },
            });
            return kit.refuse(409, `this sandbox announces at ${expected}`);
        }
        // Which copy this is, beside the last other one that announced; a daemon too old to say leaves the record as it is.
        const now = new Date();
        const copy = announcedCopyOf(body);
        const copies =
            copy === undefined
                ? undefined
                : noteAnnounce({ seen: seenCopiesOf(sandbox.seenInstances), duplicateSince: sandbox.duplicateSince }, copy, now);
        if (copies !== undefined && copies.duplicateSince !== null && sandbox.duplicateSince === null) {
            c.get(`logger`).warn(
                { sandboxId: sandbox.id, copies: copies.seen },
                `announce: two copies of this sandbox are running side by side on one token`,
            );
        }
        // Cleared here since a stored refusal must describe a live disagreement; firstAnnouncedAt is written once.
        // The removal tombstone goes with it, and for the same reason: this sandbox is plainly here, whatever was
        // deleted on some machine before. A box set up again on the same token heals its own record.
        const announced = await prisma.sandbox.updateMany({
            where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
            data: {
                daemonUrl,
                daemonVersion: version.success ? version.data : null,
                lastSeenAt: now,
                announceRefusal: Prisma.DbNull,
                removedAt: null,
                removedBy: null,
                ...(sandbox.firstAnnouncedAt === null ? { firstAnnouncedAt: now } : {}),
                ...(copies === undefined ? {} : { seenInstances: [...copies.seen], duplicateSince: copies.duplicateSince }),
            },
        });
        if (announced.count === 0) {
            return kit.refuse(404, `unknown sandbox`);
        }
        return kit.answer({ ok: true, ...(await identityField(prisma)) });
    });

    // The doors a platform that forgot a sandbox needs: adoption, and which database this is (recovery.routes.ts).
    app.route(`/`, recoveryHttpRoutes({ config, prisma }));

    /* A deletion report records that the container is gone when absence alone is ambiguous. */
    ingress(`farewell`, async (_c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        // Who removed it is a courtesy: a body that does not say is still a farewell.
        const claimed = (await kit.body())?.removedBy ?? ``;
        const removed = await prisma.sandbox.updateMany({
            where: { tokenDigest: sha256Hex(token) },
            data: { removedAt: new Date(), removedBy: claimed === `` ? null : claimed, daemonUrl: null },
        });
        return removed.count === 0 ? kit.refuse(404, `unknown sandbox`) : kit.answer({ ok: true });
    });

    /* The sandbox presents itself through the same sessionless credentialed door as announce. */
    ingress(`presentation`, async (_c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { tokenDigest: sha256Hex(token) },
            select: { name: true, image: true },
        });
        if (!sandbox) {
            return kit.refuse(404, `unknown sandbox`);
        }
        return kit.answer({ name: sandbox.name, ...(sandbox.image === null ? {} : { image: sandbox.image }) });
    });

    // A builder's report, authenticated by its per-build secret; body capped twice against an abusive caller.
    ingress(
        `hostedBuildReport`,
        async (c, kit) => {
            const secret = c.req.header(REPORT_HEADERS.secret);
            if (secret === undefined || secret === ``) {
                return kit.refuse(400, `missing build secret`);
            }
            const exitHeader = c.req.header(REPORT_HEADERS.exitCode) ?? ``;
            const exitCode = /^-?\d+$/.test(exitHeader) ? Number(exitHeader) : undefined;
            const digest = c.req.header(REPORT_HEADERS.digest) ?? ``;
            const log = await c.req.text().catch(() => ``);
            const answer = await reportHostedBuild(prisma, config, c.get(`logger`), c.req.param(`buildId`) ?? ``, secret, {
                exitCode,
                digest: /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined,
                log,
            });
            switch (answer) {
                case `unknown`:
                    return kit.refuse(404, `unknown build`);
                case `forbidden`:
                    return kit.refuse(403, `wrong build secret`);
                case `stale`:
                    return kit.refuse(409, `this build has already ended`);
                default:
                    return kit.answer({ ok: true });
            }
        },
        bodyLimit({ maxSize: 2 * LOG_TAIL_BYTES }),
    );

    // The announce's other half: whether the public address answers, authenticated the same way, same path.
    ingress(`bootReport`, async (_c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        // The whole body, as the contract states it, with the moment it arrived. (2026-10-05) The fields were once
        // named one by one here, and `retrying` and `drift` were left out: the editor's "unreachable for good" card,
        // which waits for `retrying: false`, never showed, and no setup's missing environment ever reached it.
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `malformed report`);
        }
        const report: BootReport = { ...body, at: new Date().toISOString() };
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const updated = await prisma.sandbox.updateMany({
            where: { id: sandbox.id, tokenDigest: sha256Hex(token) },
            data: { bootReport: report },
        });
        return updated.count === 0 ? kit.refuse(404, `unknown sandbox`) : kit.answer({ ok: true });
    });

    // Unauthenticated by design (existence isn't secret); matches `tunnelId` exactly, never a prefix over it. The edge
    // refuses a tunnel on a 404 and on nothing else (ingress revocation.rs), so a 404 is a deletion record and only that
    // (2026-10-02). An id with neither a row nor a record is one this database never knew or has forgotten, and answers
    // `known: false` with a 200: the edge could only be asked about it by a daemon holding a grant this platform signed,
    // and refusing it turned a restore or a wrong DATABASE_URL into every sandbox going dark within a minute. Rejected:
    // keeping 404 for both, which is what made forgetting a sandbox indistinguishable from deleting it.
    ingress(`reachability`, async (c, kit) => {
        const sandboxId = c.req.param(`sandboxId`) ?? ``;
        // Shape-checked before the query: outside the fixed alphabet/length can't be a sandbox, skip the database.
        if (!SANDBOX_ID.test(sandboxId)) {
            return kit.refuse(404, `not a sandbox id`);
        }
        const sandbox = await prisma.sandbox.findUnique({
            where: { tunnelId: sandboxId },
            select: { id: true, hosted: { select: { id: true } } },
        });
        if (sandbox === null) {
            return (await isTombstoned(prisma, sandboxId))
                ? kit.refuse(404, `deleted sandbox`)
                : kit.answer({ ok: true, lane: `tunnel`, known: false });
        }
        // Today's edge reads only the status. `lane` stays for an edge build from before the replay lane went, which
        // replays a sandbox unless it is named `tunnel`: without it, a rolled-back edge would replay tunnel sandboxes.
        return kit.answer({ ok: true, lane: sandbox.hosted === null ? `tunnel` : `hosted` });
    });

    // The edge's certificate, to an edge machine presenting the platform token (edge-certificate.ts).
    ingress(`edgeCertificate`, async (c, kit) => {
        const answer = await edgeCertificateFor(prisma, config, c.req.header(`authorization`));
        c.header(`cache-control`, `no-store`);
        return answer.status === 200 ? kit.answer(answer.body) : kit.refuse(answer.status, answer.error);
    });

    // The loopback certificate's DNS relay: a same-machine sandbox still needs a real cert for 127.0.0.1. Both routes take
    // `{ challenge? }` from a sandbox presenting its connect token, and act only on that sandbox's own record.
    const loopbackHostname = async (token: string | undefined): Promise<{ hostname: string } | { error: string; status: 400 | 404 }> => {
        if (token === undefined) {
            return { error: `missing token`, status: 400 };
        }
        const sandbox = await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) } });
        if (!sandbox) {
            return { error: `unknown sandbox`, status: 404 };
        }
        const { apiToken, zone } = config.intenticCloudflare;
        if (apiToken === `` || zone === ``) {
            return { error: `the loopback-certificate path is not enabled on this platform`, status: 404 };
        }
        const sandboxId = sandboxIdFromToken(decryptSecret(config, sandbox.token));
        if (sandboxId === undefined) {
            return { error: `this sandbox has no connect token to derive a hostname from`, status: 404 };
        }
        return { hostname: localHostname(sandboxId, zone) };
    };

    // Runs a Cloudflare call for a route: its answer, or the failure as the route's error (a bad token is the caller's 400).
    const viaCloudflare = async <T>(work: () => Promise<T>): Promise<{ body: T } | { error: string; status: 400 | 502 }> => {
        try {
            return { body: await work() };
        } catch (error) {
            if (error instanceof CloudflareTokenError) {
                return { error: error.message, status: 400 };
            }
            return { error: error instanceof Error ? error.message : `local DNS update failed`, status: 502 };
        }
    };

    const CHALLENGE_REFUSAL = `challenge must be a string of at most 128 characters`;

    // Publishes `challenge` as the sandbox's DNS-01 record, or withdraws it when absent, asserting the loopback A record.
    ingress(`localDns`, async (_c, kit) => {
        if (kit.connectToken === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, CHALLENGE_REFUSAL);
        }
        const request = await loopbackHostname(kit.connectToken);
        if (`error` in request) {
            return kit.refuse(request.status, request.error);
        }
        const { apiToken, zone } = config.intenticCloudflare;
        const answer = await viaCloudflare(async () => {
            await ensureLocalDnsRecord(apiToken, zone);
            await setAcmeChallenge(apiToken, zone, `_acme-challenge.${request.hostname}`, body.challenge);
            return { ok: true as const, hostname: request.hostname };
        });
        return `error` in answer ? kit.refuse(answer.status, answer.error) : kit.answer(answer.body);
    });

    // Cloudflare's own word on whether the sandbox's DNS-01 record holds `challenge`: the proof a sandbox whose network
    // cannot see the zone's nameservers orders on (obtainCertificate's `confirmChallenge`). Read-only.
    ingress(`localDnsConfirm`, async (_c, kit) => {
        if (kit.connectToken === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `challenge is required: ${CHALLENGE_REFUSAL}`);
        }
        const request = await loopbackHostname(kit.connectToken);
        if (`error` in request) {
            return kit.refuse(request.status, request.error);
        }
        const { apiToken, zone } = config.intenticCloudflare;
        const recordName = `_acme-challenge.${request.hostname}`;
        const answer = await viaCloudflare(async () => ({ confirmed: await acmeChallengeHolds(apiToken, zone, recordName, body.challenge) }));
        return `error` in answer ? kit.refuse(answer.status, answer.error) : kit.answer(answer.body);
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

    // The provisioning door: an account-scoped API token, not a session, so a sandbox can create sandboxes for its
    // owner. Rows and claims only — never a hosted machine.
    app.route(`/fleet`, fleetHttpRoutes({ config, prisma }));

    // A development lane: admin READS replayed against another deployment, so a local panel can show its figures; off
    // (404s) unless ADMIN_UPSTREAM_URL and ADMIN_UPSTREAM_COOKIE are both set.
    app.route(`/upstream`, adminUpstreamRoutes({ config, prisma, auth }));

    // A request that waits on a machine keeps its connection however long the wait (MACHINE_CHANGE_PATHS above).
    app.use(`${API_BASE_PATH}/*`, keepMachineChangesOpen);

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
