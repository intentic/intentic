import { existsSync, readFileSync } from "node:fs";
import { LEAF_CRT, LEAF_KEY } from "@intentic-app/localhost-https/paths";
import { createApp } from "./app.js";
import { CONFIG_SECRETS, loadConfig } from "./config.js";
import { mask } from "./log.js";
import { createLogger } from "./logger.js";
import { createPrisma } from "./prisma.js";
import { startPoolCycle } from "./pool/pool-cycle-job.js";
import { seedDemoService } from "./pool/pool-demo.js";
import { startHostedPool } from "./sandbox/hosted/hosted-pool.js";
import { startRetention } from "./retention.js";
import { startTracing } from "./tracing.js";

// Standard OTEL_* vars come from the environment. The dev/start scripts pass `--env-file=../../.env` so the
// root .env populates process.env under Bun (it only auto-loads .env from cwd); in prod they're real env vars.
const tracing = startTracing();

// Bun is the API runtime: it executes this TypeScript (and the source-first workspace libs) directly, no
// build step in dev. `bun --watch` restarts on change. Bun.serve is the native server; it takes Hono's
// fetch handler as-is and terminates TLS itself in dev (prod runs plain http behind a TLS proxy).
const config = loadConfig();
const logger = createLogger(config);
logger.info({ config: mask(config, CONFIG_SECRETS) }, `config loaded`);
if (!config.google.clientId || !config.google.clientSecret) {
    logger.warn(`GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset: Google sign-in will fail until they are provided`);
}
if (!config.secrets.key) {
    logger.warn(`SECRETS_KEY unset: OAuth/sandbox tokens will be persisted in plaintext (never run production like this)`);
}
if (!config.email.apiKey || !config.email.from) {
    logger.warn(`EMAIL_API_KEY/EMAIL_FROM unset: sandbox invite links will be logged instead of emailed`);
}

const prisma = createPrisma(config);
startRetention(prisma, config, logger);
// Freezes every finished month the platform has not closed yet, then pays out everything that has come due.
// The frozen month is what payouts settle on, and the only record of what was owed once the ledger rows behind
// it age out. No-ops on a platform without a pool.
startPoolCycle(prisma, config, logger);
// Keeps warm hosted machines built ahead of demand (and drains them when the pool is off), see hosted-pool.ts.
startHostedPool(prisma, config, logger);
// The demo service's row follows the POOL_DEMO_SERVICE flag: seeded/reactivated on, delisted off. Unawaited
// and self-swallowing, a catalog short one demo row must never hold the platform's boot.
void seedDemoService(prisma, config).catch((error: unknown) => logger.warn({ err: error }, `pool: demo service seed failed`));
const { app } = createApp(config, prisma, logger);

/* Dev serves https (the SPA does too, for FedCM); prod runs plain http behind a TLS-terminating proxy.
 *
 * API_HTTPS_KEY/CERT win when set. Otherwise dev falls back to the pair `pnpm install` mints for this user,
 * because that pair no longer has a path anyone could write into a .env: it lives in this user's own data
 * directory, which differs per person and per OS. Two guards keep the fallback out of production, not being
 * production, and the pair actually existing, which on a server it does not because nothing mints it there. */
const devPair = (): { key: Buffer; cert: Buffer } | undefined => {
    if (process.env[`NODE_ENV`] === `production` || !existsSync(LEAF_KEY) || !existsSync(LEAF_CRT)) {
        return undefined;
    }
    return { key: readFileSync(LEAF_KEY), cert: readFileSync(LEAF_CRT) };
};
const tls =
    config.api.httpsKey && config.api.httpsCert ? { key: readFileSync(config.api.httpsKey), cert: readFileSync(config.api.httpsCert) } : devPair();

const server = Bun.serve({
    port: config.api.port,
    hostname: config.api.host,
    fetch: app.fetch,
    ...(tls && { tls }),
});

// Bound to the loopback IP but advertised as localhost: that is the name the dev cert covers, the origin the
// SPA calls, and the one Better Auth/CORS trust. Printing the IP invites a click that lands on an untrusted
// origin, which the API then rejects with a bare preflight 204 the browser reports as an opaque CORS error.
logger.info({ url: `${tls ? `https` : `http`}://localhost:${server.port}` }, `api started (auth at /api/auth, oRPC at /rpc)`);

const shutdown = async () => {
    logger.info(`shutting down`);
    await prisma.$disconnect();
    await server.stop();
    await tracing?.shutdown();
    process.exit(0);
};

process.on(`SIGTERM`, () => void shutdown());
process.on(`SIGINT`, () => void shutdown());
