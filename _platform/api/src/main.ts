import { existsSync, readFileSync } from "node:fs";
import { LEAF_CRT, LEAF_KEY } from "@intentic/localhost-https/paths";
import { createApp } from "./app.js";
import { CONFIG_SECRETS, loadConfig } from "./config.js";
import { mask } from "./log.js";
import { createLogger } from "./logger.js";
import { createPrisma } from "./prisma.js";
import { startHostedBuilds } from "./sandbox/hosted/build/hosted-build.js";
import { startHostedCanary } from "./sandbox/hosted/hosted-canary.js";
import { startHostedCleanup } from "./sandbox/hosted/hosted-cleanup.js";
import { startHostedHealth } from "./sandbox/hosted/hosted-health.js";
import { startHostedMeter } from "./sandbox/hosted/hosted-meter.js";
import { hostedPlanEnabled } from "./sandbox/hosted/hosted-plan.js";
import { startHostedPool } from "./sandbox/hosted/hosted-pool.js";
import { startRetention } from "./retention.js";
import { startTracing } from "./tracing.js";

// OTEL_* vars come from the environment; dev scripts pass --env-file so the root .env populates them under Bun.
const tracing = startTracing();

// Bun runs this TypeScript directly, no build step in dev; Bun.serve takes Hono's fetch handler as-is.
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
// A plan on sale with no webhook secret would take payment and refuse activation for every buyer via a 400.
if (hostedPlanEnabled(config) && !config.hostedPlan.stripeWebhookSecret) {
    logger.error(
        `HOSTED_PLAN_STRIPE_WEBHOOK_SECRET unset while the hosted plan is on sale: every payment will be taken and no plan will ever activate`,
    );
}

const prisma = createPrisma(config);
startHostedCleanup(prisma, config, logger);
startRetention(prisma, config, logger);
// Keeps warm hosted machines built ahead of demand, and drains them when the pool is off (hosted-pool.ts).
startHostedPool(prisma, config, logger);
// Ends builds whose builder never reported and destroys builders past their timeout (hosted-build.ts).
startHostedBuilds(prisma, config, logger);
// Closes the stretch of every stopped machine and stops a free machine whose owner's month is spent.
startHostedMeter(prisma, config, logger);
// Watches the hosted lane against Fly and says so when they disagree; read-only (hosted-health.ts).
startHostedHealth(prisma, config, logger);
// Provisions a sandbox end to end and waits for its daemon, off unless HOSTED_CANARY_MINUTES is set.
startHostedCanary(prisma, config, logger);
const { app } = createApp(config, prisma, logger);

// Falls back to the pair pnpm install mints for this user (their own data directory) when the config knobs are unset.
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

// Bound to loopback but advertised as localhost: the name the dev cert, CORS and Better Auth all trust.
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
